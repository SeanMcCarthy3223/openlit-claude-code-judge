package claudecode

// Subagent transcript drain.
//
// Claude Code writes a subagent's (Task tool) and workflow-subagent's
// conversation to a SEPARATE transcript file under
// `<main-transcript-dir>/<session-id>/subagents/**/agent-<id>.jsonl`,
// NOT the main session transcript. The main-transcript reader
// (drainAssistantTurns) therefore never sees a subagent's assistant
// turns, so before this file:
//
//   - the subagent's tokens + cost were entirely missing from the trace
//     (the `coding_agent.subagent` span carries no usage), and
//   - the `coding_agent.tool.call` spans — which DO fire via
//     Pre/PostToolUse even for tools run inside a subagent — carried no
//     owner, so you couldn't tell which subagent ran which action.
//
// This file fixes both. On each relevant hook event we:
//
//  1. Eagerly index every `tool_use` id we can see in the subagent
//     transcripts to its owning agent id, so the PostToolUse handler can
//     stamp `coding_agent.agent.id` onto the matching tool.call span as
//     it fires (tagging the action with its subagent).
//  2. Emit one `coding_agent.llm.turn` span per *completed* subagent
//     turn, tagged with `coding_agent.agent.id` / `agent.type=subagent`
//     / `subagent.type`, with exact per-turn tokens + cache + cost — the
//     same shape drainAssistantTurns produces for the main session.
//
// Tail safety: subagent transcripts frequently never flush a
// `stop_reason` fragment (unlike the main transcript), so we cannot gate
// turn completeness on stop_reason the way coalesceAssistants does.
// Instead a turn is "complete" once another line follows it in the file;
// the trailing (possibly still-streaming) turn is held until the next
// drain, or flushed on SubagentStop / SessionEnd. Token indexing is NOT
// gated this way — ids are indexed from every line read so an in-flight
// turn's tools still get tagged immediately.

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/openlit/openlit/cli/internal/coding/normalize"
	"github.com/openlit/openlit/cli/internal/coding/pricing"
	"github.com/openlit/openlit/cli/internal/coding/sessionstate"
	"github.com/openlit/openlit/sdk/go/semconv"
)

const (
	// subagentToolIndexCap bounds the tool_use -> agent map so a runaway
	// session can't grow sessionstate unbounded. 8192 comfortably holds
	// the tool calls of a large multi-subagent workflow.
	subagentToolIndexCap = 8192
	// emittedSubagentTurnCap bounds the dedup set of already-emitted
	// subagent turn keys.
	emittedSubagentTurnCap = 1024
)

// drainSubagentTurns is the entry point, called from handle() near the
// top (after drainAssistantTurns) on the events where it matters:
// PostToolUse (so the tool index is fresh when we tag the tool.call),
// Stop, SubagentStop, and SessionEnd (turn capture + flush).
func drainSubagentTurns(in normalize.Input, p claudePayload) {
	event := in.Event
	if event == "" {
		event = p.HookEventName
	}
	switch event {
	case "PostToolUse", "Stop", "SubagentStop", "SessionEnd":
		// proceed
	default:
		return
	}

	sessionID := p.SessionID
	if sessionID == "" {
		return
	}
	st := sessionstate.Load(sessionID, "claude-code")
	if st == nil {
		st = &sessionstate.State{}
	}

	transcriptPath := strings.TrimSpace(p.TranscriptPath)
	if transcriptPath == "" {
		transcriptPath = st.TranscriptPath
	}
	if transcriptPath == "" {
		return
	}
	if strings.HasPrefix(transcriptPath, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			transcriptPath = filepath.Join(home, strings.TrimPrefix(transcriptPath, "~/"))
		}
	}
	// The session dir is the transcript path with its `.jsonl` stripped;
	// subagent transcripts live under its `subagents/` subtree.
	subagentsDir := filepath.Join(strings.TrimSuffix(transcriptPath, ".jsonl"), "subagents")
	if info, err := os.Stat(subagentsDir); err != nil || !info.IsDir() {
		return
	}

	// On SubagentStop / SessionEnd a subagent (or the whole session) has
	// ended, so flush the trailing turn of each file too.
	flush := event == "SubagentStop" || event == "SessionEnd"

	files := findSubagentTranscripts(subagentsDir)
	if len(files) == 0 {
		return
	}

	if st.SubagentOffsets == nil {
		st.SubagentOffsets = map[string]int64{}
	}
	if st.SubagentToolIndex == nil {
		st.SubagentToolIndex = map[string]string{}
	}
	seen := make(map[string]struct{}, len(st.EmittedSubagentTurnIDs))
	for _, id := range st.EmittedSubagentTurnIDs {
		seen[id] = struct{}{}
	}

	changed := false
	for _, file := range files {
		agentID := agentIDFromFile(file)
		if agentID == "" {
			continue
		}
		lines, _, rerr := readTranscript(file, st.SubagentOffsets[file])
		if rerr != nil || len(lines) == 0 {
			continue
		}

		// (1) Eager tool_use -> agent index from EVERY assistant line
		// read, including the trailing in-flight turn. Indexing is
		// idempotent and not tail-gated so PostToolUse can tag a tool
		// call whose turn hasn't "completed" yet.
		for _, l := range lines {
			if l.Type != "assistant" {
				continue
			}
			var m assistantMessage
			if err := json.Unmarshal(l.Message, &m); err != nil {
				continue
			}
			for _, b := range m.Content {
				if b.Type != "tool_use" || b.ID == "" {
					continue
				}
				if _, ok := st.SubagentToolIndex[b.ID]; !ok && len(st.SubagentToolIndex) < subagentToolIndexCap {
					st.SubagentToolIndex[b.ID] = agentID
					changed = true
				}
			}
		}

		// (2) Emit completed subagent turns (tail-safe), advancing the
		// per-file offset only past what we committed.
		turns, safeOffset := coalesceSubagentTurns(lines, st.SubagentOffsets[file], flush)
		if safeOffset > st.SubagentOffsets[file] {
			st.SubagentOffsets[file] = safeOffset
			changed = true
		}
		if len(turns) == 0 {
			continue
		}
		subType := subagentTypeForFile(file)
		for _, t := range turns {
			key := agentID + "|" + t.key()
			if _, ok := seen[key]; ok {
				continue
			}
			emitSubagentTurn(in, p, agentID, subType, t)
			seen[key] = struct{}{}
			st.EmittedSubagentTurnIDs = append(st.EmittedSubagentTurnIDs, key)
			changed = true
		}
	}

	if len(st.EmittedSubagentTurnIDs) > emittedSubagentTurnCap {
		st.EmittedSubagentTurnIDs = st.EmittedSubagentTurnIDs[len(st.EmittedSubagentTurnIDs)-emittedSubagentTurnCap:]
	}
	if changed {
		sessionstate.Save(sessionID, "claude-code", st)
	}
}

// subagentTurn is one coalesced assistant turn read from a subagent
// transcript. `line`/`msg` are the final fragment (authoritative model +
// usage + stop_reason); `content` is the union of content blocks across
// all fragments of the turn (for text/thinking reconstruction).
type subagentTurn struct {
	line    transcriptLine
	msg     assistantMessage
	content []assistantContentBlock
}

func (t subagentTurn) key() string {
	if k := strings.TrimSpace(t.line.RequestID); k != "" {
		return k
	}
	return t.line.UUID
}

// coalesceSubagentTurns groups consecutive assistant lines sharing a
// requestId into one turn (streaming fragments repeat identical cache
// usage; the final fragment carries the cumulative output). A turn is
// returned as committed only when a subsequent line follows it in the
// read window — i.e. the turn is definitely finished — unless `flush`
// is set, in which case the trailing turn is committed too. `safeOffset`
// is the byte position the caller may persist; the trailing in-flight
// turn (when held) is left for the next read.
func coalesceSubagentTurns(lines []transcriptLine, inOffset int64, flush bool) ([]subagentTurn, int64) {
	if len(lines) == 0 {
		return nil, inOffset
	}

	type grp struct {
		lines    []transcriptLine
		firstIdx int
	}
	var groups []grp
	i := 0
	for i < len(lines) {
		if lines[i].Type != "assistant" {
			i++
			continue
		}
		rid := lines[i].RequestID
		g := grp{firstIdx: i, lines: []transcriptLine{lines[i]}}
		j := i + 1
		if rid != "" {
			for j < len(lines) && lines[j].Type == "assistant" && lines[j].RequestID == rid {
				g.lines = append(g.lines, lines[j])
				j++
			}
		}
		groups = append(groups, g)
		i = j
	}

	if len(groups) == 0 {
		// Only user/attachment lines — nothing to emit, but commit past
		// them so we don't re-read on every event.
		return nil, lines[len(lines)-1].endOffset
	}

	lastLineIsAssistant := lines[len(lines)-1].Type == "assistant"
	holdTrailing := lastLineIsAssistant && !flush

	var turns []subagentTurn
	safe := inOffset
	for gi, g := range groups {
		if holdTrailing && gi == len(groups)-1 {
			// Leave the trailing (possibly still-streaming) turn for the
			// next drain; commit only up to where it begins.
			startByte := inOffset
			if g.firstIdx > 0 {
				startByte = lines[g.firstIdx-1].endOffset
			}
			if startByte > safe {
				safe = startByte
			}
			return turns, safe
		}
		if t, ok := buildSubagentTurn(g.lines); ok {
			turns = append(turns, t)
		}
		safe = g.lines[len(g.lines)-1].endOffset
	}
	// Committed every group (flush, or the read ended on a non-assistant
	// line): advance to the end of what we read.
	if eo := lines[len(lines)-1].endOffset; eo > safe {
		safe = eo
	}
	return turns, safe
}

func buildSubagentTurn(group []transcriptLine) (subagentTurn, bool) {
	if len(group) == 0 {
		return subagentTurn{}, false
	}
	last := group[len(group)-1]
	var lmsg assistantMessage
	if err := json.Unmarshal(last.Message, &lmsg); err != nil {
		return subagentTurn{}, false
	}
	var content []assistantContentBlock
	for _, l := range group {
		var m assistantMessage
		if err := json.Unmarshal(l.Message, &m); err != nil {
			continue
		}
		content = append(content, m.Content...)
	}
	return subagentTurn{line: last, msg: lmsg, content: content}, true
}

// emitSubagentTurn produces one `coding_agent.llm.turn` span for a
// subagent turn, mirroring emitOneAssistantTurn but tagging the span
// with the owning subagent's identity so the dashboard can attribute
// the tokens / cost / chat content to the right child agent.
func emitSubagentTurn(in normalize.Input, p claudePayload, agentID, subType string, t subagentTurn) {
	completedAt, _ := time.Parse(time.RFC3339Nano, t.line.Timestamp)
	if completedAt.IsZero() {
		completedAt = time.Now()
	}

	turn := normalize.LLMTurn{
		SessionID:           p.SessionID,
		ConversationID:      p.SessionID,
		GenerationID:        strings.TrimSpace(t.line.RequestID),
		Vendor:              in.Vendor,
		Model:               t.msg.Model,
		StartedAt:           completedAt,
		EndedAt:             completedAt,
		InputTokens:         t.msg.Usage.InputTokens + t.msg.Usage.CacheReadInputTokens + t.msg.Usage.CacheCreationInputTokens,
		OutputTokens:        t.msg.Usage.OutputTokens,
		CacheReadTokens:     t.msg.Usage.CacheReadInputTokens,
		CacheCreationTokens: t.msg.Usage.CacheCreationInputTokens,
	}
	turn.TotalTokens = turn.InputTokens + turn.OutputTokens
	if t.msg.StopReason != "" {
		turn.FinishReasons = []string{t.msg.StopReason}
	}
	if t.msg.Model != "" {
		rate := pricing.Lookup(t.msg.Model)
		turn.CostUSD = rate.Cost(turn.InputTokens, turn.OutputTokens, turn.CacheReadTokens, turn.CacheCreationTokens)
	}

	// Subagent association tags — the join key (agent.id) + type, plus a
	// sidechain marker. These ride on LLMTurn.Extras, which the emitter
	// stamps verbatim as string span attributes, so no normalize/attrs
	// schema change is needed.
	//
	// NOTE: we deliberately do NOT set coding_agent.agent.parent_id here.
	// These turns already live in the parent session's bucket via
	// coding_agent.session.id, so a parent_id equal to the session id is
	// redundant — and the dashboard's `is_subagent` heuristic flags any
	// group that has a non-empty parent_id WITHOUT checking
	// parent_id != session_id, which would wrongly classify the whole
	// parent session as a subagent and hide it from the Sessions list.
	// agent.id + agent.type=subagent are sufficient to attribute and group
	// these turns; real (separate-session) subagents still carry a parent_id
	// pointing at a DIFFERENT session and remain correctly nested.
	turn.Extras = map[string]string{
		semconv.CodingAgentAgentID:   agentID,
		semconv.CodingAgentAgentType: semconv.CodingAgentAgentTypeSubagent,
		"claude_code.is_sidechain":   "true",
	}
	if subType != "" {
		turn.Extras[semconv.CodingAgentSubagentType] = subType
	}
	if v := strings.TrimSpace(t.line.Version); v != "" {
		turn.Extras["claude_code.client.version"] = v
	}
	if v := strings.TrimSpace(t.line.Entrypoint); v != "" {
		turn.Extras["claude_code.entrypoint"] = v
	}
	if v := strings.TrimSpace(t.line.GitBranch); v != "" {
		turn.Extras["vcs.ref.head.name"] = v
	}
	if v := strings.TrimSpace(t.line.CWD); v != "" {
		turn.Extras["code.cwd"] = v
	}

	if in.ContentCapture == semconv.CodingAgentContentCaptureFull {
		text, thinking := splitAssistantContent(t.content)
		turn.Response = text
		turn.ThoughtText = thinking
	}

	_ = in.Emit.EmitLLMTurn(turn)
}

// findSubagentTranscripts walks the subagents subtree for agent-<id>.jsonl
// files (workflow subagents nest under subagents/workflows/<wf>/...).
func findSubagentTranscripts(dir string) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, "agent-") && strings.HasSuffix(name, ".jsonl") {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// agentIDFromFile extracts the stable agent id from an agent-<id>.jsonl
// path (e.g. ".../agent-a04e92838d17579da.jsonl" -> "a04e92838d17579da").
func agentIDFromFile(path string) string {
	base := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	return strings.TrimPrefix(base, "agent-")
}

// subagentTypeForFile reads the sibling agent-<id>.meta.json for the
// vendor's subagent kind (e.g. {"agentType":"Explore"}). Best-effort —
// returns "" when the meta file is missing or unparseable.
func subagentTypeForFile(path string) string {
	meta := strings.TrimSuffix(path, ".jsonl") + ".meta.json"
	b, err := os.ReadFile(meta)
	if err != nil {
		return ""
	}
	var m struct {
		AgentType string `json:"agentType"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return ""
	}
	return m.AgentType
}

// SubagentUsage is the rolled-up usage across all of a session's subagent
// transcripts.
type SubagentUsage struct {
	InputTokens   int64
	OutputTokens  int64
	CostUSD       float64
	SubagentCount int
}

// sumSubagentUsage walks <main-transcript>/subagents/** and sums the per-turn
// usage of every subagent turn (coalescing streaming fragments by requestId,
// pricing each turn by its own model). emitSession folds this into the
// session-root span so the rollup reflects the FULL workload — tailTranscript
// reads only the main transcript and would otherwise exclude all subagent
// tokens/cost. Best-effort; returns the zero value on any error.
func sumSubagentUsage(mainTranscriptPath string) SubagentUsage {
	var u SubagentUsage
	p := strings.TrimSpace(mainTranscriptPath)
	if p == "" {
		return u
	}
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, strings.TrimPrefix(p, "~/"))
		}
	}
	subagentsDir := filepath.Join(strings.TrimSuffix(p, ".jsonl"), "subagents")
	if info, err := os.Stat(subagentsDir); err != nil || !info.IsDir() {
		return u
	}
	files := findSubagentTranscripts(subagentsDir)
	u.SubagentCount = len(files)
	for _, file := range files {
		lines, _, err := readTranscript(file, 0)
		if err != nil || len(lines) == 0 {
			continue
		}
		turns, _ := coalesceSubagentTurns(lines, 0, true) // flush=true: sum every turn
		for _, t := range turns {
			in := t.msg.Usage.InputTokens + t.msg.Usage.CacheReadInputTokens + t.msg.Usage.CacheCreationInputTokens
			u.InputTokens += in
			u.OutputTokens += t.msg.Usage.OutputTokens
			if t.msg.Model != "" {
				u.CostUSD += pricing.Lookup(t.msg.Model).Cost(
					in, t.msg.Usage.OutputTokens,
					t.msg.Usage.CacheReadInputTokens, t.msg.Usage.CacheCreationInputTokens,
				)
			}
		}
	}
	return u
}
