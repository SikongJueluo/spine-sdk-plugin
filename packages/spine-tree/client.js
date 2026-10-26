window.__ModuleLoader__.load({
  id: "@spinejit/dsh-spine-tree",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = "spine-tree";
    const VIEW_ROUTE = "api/spine.tree";
    const REQUEST_ROUTE = "api/spine.request";
    const POLL_MS = 1000;
    const STALE_MS = 4000;

    const CSS = `
.spt-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}
.spt-styled{display:contents}
.spt-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);flex:0 0 auto}
.spt-tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.spt-tab{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:6px;padding:3px 10px;cursor:pointer;white-space:nowrap}
.spt-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.spt-tab:focus-visible,.spt-button:focus-visible,.spt-row:focus-visible,.spt-detail summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.spt-pills{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
.spt-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);white-space:nowrap}
.spt-pill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.spt-pill[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.spt-pill[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.spt-pill[data-tone="idle"]{color:var(--dsw-alias-state-idle-primary)}
.spt-button{font:inherit;font-size:12px;padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}
.spt-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.spt-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(280px,42%) minmax(0,1fr)}
.spt-list{overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:4px 0 16px;min-height:0}
.spt-detail{overflow:auto;padding:12px 16px 40px;min-height:0}
.spt-row{display:flex;align-items:flex-start;gap:6px;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:0;border-left:2px solid transparent;padding:4px 10px 4px 6px;cursor:pointer;min-height:26px}
.spt-row:hover{background:var(--dsw-alias-bg-layer-1)}
.spt-row[data-selected="true"]{background:var(--dsw-alias-bg-layer-2);border-left-color:var(--dsw-alias-brand-primary)}
.spt-row[data-cursor="true"] .spt-rowTitle{font-weight:600}
.spt-levels{display:inline-flex;flex:0 0 auto;align-self:stretch}
.spt-level{display:inline-block;width:14px;border-left:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.spt-caret{flex:0 0 14px;width:14px;height:18px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:10px;background:transparent;border:0;padding:0;cursor:pointer;font-family:inherit}
.spt-caretSpacer{flex:0 0 14px;width:14px}
.spt-glyph{flex:0 0 auto;width:12px;text-align:center;font-size:10px;line-height:18px}
.spt-rowMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.spt-rowTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spt-rowMeta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.spt-badge{font-size:10px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.spt-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.spt-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.spt-badge[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.spt-badge[data-tone="idle"]{color:var(--dsw-alias-state-idle-primary)}
.spt-h{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:16px 0 6px}
.spt-title{font-size:15px;font-weight:600;margin:0 0 6px;overflow-wrap:anywhere}
.spt-sub{color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.spt-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 12px;font-size:12px}
.spt-kv dt{color:var(--dsw-alias-label-secondary)}
.spt-kv dd{margin:0;overflow-wrap:anywhere}
.spt-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;margin:0 0 8px;background:var(--dsw-alias-bg-layer-1)}
.spt-cardHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px}
.spt-pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto}
.spt-text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.spt-detail>details,.spt-card>details{margin:6px 0}
.spt-detail summary,.spt-card summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.spt-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin:6px 0}
.spt-empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:24px 16px;max-width:640px}
.spt-emptyTitle{font-size:14px;font-weight:600}
.spt-emptyBody{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;margin:0}
.spt-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}
.spt-listRow{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:0;border-left:2px solid transparent;padding:5px 12px;cursor:pointer}
.spt-listRow:hover{background:var(--dsw-alias-bg-layer-1)}
.spt-listRow[data-selected="true"]{background:var(--dsw-alias-bg-layer-2);border-left-color:var(--dsw-alias-brand-primary)}
.spt-listTop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.spt-listTime{font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-secondary)}
.spt-diff{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.spt-diff:last-child{border-bottom:0}
.spt-diffCat{flex:0 0 168px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.spt-diffBody{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.spt-diffPreview{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.spt-planRow{display:grid;grid-template-columns:34px 1fr;gap:2px 8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.spt-planRow:last-child{border-bottom:0}
.spt-planIndex{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.spt-back{display:none}
.spt-msg{border-top:1px solid var(--dsw-alias-border-l1);padding:6px 0}
.spt-msg:first-child{border-top:0}
.spt-msgHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.spt-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (max-width:860px){
.spt-body{grid-template-columns:minmax(0,1fr)}
.spt-detail{display:none;border-right:0}
.spt-list{display:block;border-right:0}
.spt-root[data-pane="detail"] .spt-list{display:none}
.spt-root[data-pane="detail"] .spt-detail{display:block}
.spt-back{display:inline-flex}
}
`;

    //#region dictionaries
    const ZH = {
      "view.label": "Spine Tree",
      "mode.tree": "树浏览",
      "mode.requests": "请求审计",
      "status.live": "实时",
      "status.reconstructed": "重建",
      "status.unavailable": "不可用",
      "status.stale": "数据陈旧",
      "status.disconnected": "连接中断",
      "status.loading": "加载中",
      "status.fault": "异常",
      "status.following": "跟随执行光标",
      "action.follow": "跟随光标",
      "action.refresh": "刷新",
      "action.back": "返回",
      "action.retry": "重试",
      "action.expand": "展开",
      "action.collapse": "折叠",
      "tree.unavailable": "Spine 树不可用",
      "tree.empty": "此会话还没有 Spine 节点。",
      "tree.emptyHint": "Spine 节点会在第一次采样提交后出现。",
      "unavailable.title": "Spine 未启用",
      "unavailable.body": "当前会话所属的 preset 没有提供 Spine 检查数据，因此没有可读取的树或请求证据。查看器不会自行伪造数据。",
      "unavailable.hint": "在 preset 中启用 packages/plugin 的 deepseek-harness 扩展（inspect 未关闭），并用该 preset 新建会话；本页随后会显示实时树与请求证据。",
      "error.title": "无法读取 Spine 数据",
      "error.network": "与宿主的数据通道中断，正在重试。",
      "detail.overview": "概览",
      "detail.memory": "返回的 memory",
      "detail.noMemory": "此节点还没有记录 memory。",
      "detail.raw": "原始节点 JSON",
      "field.kind": "类型",
      "field.status": "状态",
      "field.id": "节点 id",
      "field.start": "起点 boundary",
      "field.end": "终点 boundary",
      "field.parent": "父节点",
      "field.children": "子节点",
      "field.boundary": "boundary",
      "field.anchor": "锚点",
      "field.span": "source span",
      "field.outcome": "结果",
      "field.diagnostic": "诊断",
      "field.execution": "执行引用",
      "field.task": "任务",
      "field.prompt": "任务提示",
      "kind.root": "RootEpoch",
      "kind.task": "Task",
      "nodeStatus.live": "Live",
      "nodeStatus.opened": "Opened",
      "nodeStatus.closed": "Closed",
      "nodeStatus.compacted": "Compacted",
      "memory.user": "用户输入",
      "memory.summary": "总结 memory",
      "memory.spawn": "Spawn 证据",
      "requests.emptyTitle": "还没有请求证据",
      "requests.emptyBody": "从功能启用后开始捕获请求。历史请求不会被事后重建，本版本也不会用日志猜测当时的完整请求；因此这里只显示现场证据。",
      "requests.captureHint": "下一次模型请求完成后，这里会出现一条记录。",
      "requests.unavailableBody": "请求证据存储不可用。树浏览仍然可用。",
      "request.select": "选择左侧一条请求查看详情。",
      "request.overview": "请求概览",
      "request.capturedAt": "捕获时间",
      "request.evidence": "证据性质",
      "request.evidence.live": "现场捕获",
      "request.model": "模型",
      "request.provider": "provider",
      "request.attempt": "计划内请求序号",
      "request.planRef": "计划版本",
      "request.messages": "消息数",
      "request.tools": "工具声明",
      "request.bytes": "存储字节",
      "request.truncated": "请求正文超过上限，已截断；对照结论为证据不足。",
      "request.planTitle": "Spine 计划",
      "request.planMissing": "这次请求没有捕获到对应的 Spine 计划，无法比较。",
      "request.planCell": "计划单元",
      "request.planNoCells": "计划为空。",
      "request.messagesTitle": "冻结请求内容",
      "request.hostLayer": "宿主层（不属于 Spine 计划）",
      "request.hostLayerBody": "系统提示、developer 消息与工具声明由 DSH 宿主负责，Spine 不规划它们。",
      "request.differencesTitle": "对照差异",
      "request.noDifferences": "没有差异：计划的每条消息都按顺序、一次且内容一致地进入请求。",
      "request.notesTitle": "说明",
      "request.raw": "原始证据 JSON",
      "request.expected": "期望",
      "request.actual": "实际",
      "request.matched": "命中请求消息 #{index}",
      "request.unmatched": "未进入请求",
      "request.hostSystem": "系统提示消息 {n} 条",
      "request.hostDeveloper": "developer 消息 {n} 条",
      "request.scopeNote": "对照的是 DSH 组装完成的冻结请求，不是 provider HTTP 报文。",
      "audit.consistent": "一致",
      "audit.known": "已知差异",
      "audit.unexplained": "未解释差异",
      "audit.insufficient": "证据不足",
      "audit.short.consistent": "一致",
      "audit.short.known": "已知差异",
      "audit.short.unexplained": "未解释",
      "audit.short.insufficient": "证据不足",
      "diff.missing-plan-message": "计划消息缺失",
      "diff.unexpected-request-message": "请求出现计划外消息",
      "diff.content-changed": "同一消息内容被改写",
      "diff.order": "顺序异常",
      "diff.duplicate": "重复消息",
      "diff.anchor-presentation": "User 锚点呈现差异",
      "diff.host-layer": "宿主层",
      "diff.truncated": "证据截断",
      "diff.plan-unavailable": "缺少计划",
      "diff.plan-unmaterializable": "计划无法物化",
      "summary.expected": "计划 {n} 条",
      "summary.actual": "请求 {n} 条",
      "summary.matched": "命中 {n} 条",
      "summary.unexplained": "未解释 {n} 条",
      "footer.ledger": "Ledger：{entries} 条记录（{archives} 归档 / {spawn} spawn 终态）",
      "footer.evidence": "请求证据：{count} 条",
      "footer.evidenceError": "请求证据不可读：{message}",
      "empty.session": "尚未选择会话。",
    };
    const EN = {
      "view.label": "Spine Tree",
      "mode.tree": "Tree",
      "mode.requests": "Requests",
      "status.live": "Live",
      "status.reconstructed": "Reconstructed",
      "status.unavailable": "Unavailable",
      "status.stale": "Stale data",
      "status.disconnected": "Disconnected",
      "status.loading": "Loading",
      "status.fault": "Fault",
      "status.following": "Following cursor",
      "action.follow": "Follow cursor",
      "action.refresh": "Refresh",
      "action.back": "Back",
      "action.retry": "Retry",
      "action.expand": "Expand",
      "action.collapse": "Collapse",
      "tree.unavailable": "Spine tree unavailable",
      "tree.empty": "This Session has no Spine nodes yet.",
      "tree.emptyHint": "Nodes appear after the first committed sampling.",
      "unavailable.title": "Spine is not enabled",
      "unavailable.body": "The preset this Session uses does not provide Spine inspection data, so there is no tree or request evidence to read. The viewer does not invent one.",
      "unavailable.hint": "Enable the deepseek-harness extension from packages/plugin in the preset (with inspect not disabled), then open a Session of that preset; this page then shows the live tree and request evidence.",
      "error.title": "Could not read Spine data",
      "error.network": "The host data channel is down; retrying.",
      "detail.overview": "Overview",
      "detail.memory": "Returned memory",
      "detail.noMemory": "No memory recorded for this node yet.",
      "detail.raw": "Raw node JSON",
      "field.kind": "Kind",
      "field.status": "Status",
      "field.id": "Node id",
      "field.start": "Start boundary",
      "field.end": "End boundary",
      "field.parent": "Parent",
      "field.children": "Children",
      "field.boundary": "Boundary",
      "field.anchor": "Anchor",
      "field.span": "Source span",
      "field.outcome": "Outcome",
      "field.diagnostic": "Diagnostic",
      "field.execution": "Execution ref",
      "field.task": "Task",
      "field.prompt": "Task prompt",
      "kind.root": "RootEpoch",
      "kind.task": "Task",
      "nodeStatus.live": "Live",
      "nodeStatus.opened": "Opened",
      "nodeStatus.closed": "Closed",
      "nodeStatus.compacted": "Compacted",
      "memory.user": "User input",
      "memory.summary": "Summary memory",
      "memory.spawn": "Spawn evidence",
      "requests.emptyTitle": "No request evidence yet",
      "requests.emptyBody": "Requests are captured from the moment the feature is enabled. Historical requests are not reconstructed after the fact, and this version never guesses a past request from logs; only observed evidence is shown.",
      "requests.captureHint": "A record appears here after the next completed model request.",
      "requests.unavailableBody": "Request evidence storage is unavailable. Tree browsing still works.",
      "request.select": "Select a request on the left to inspect it.",
      "request.overview": "Request overview",
      "request.capturedAt": "Captured at",
      "request.evidence": "Evidence",
      "request.evidence.live": "Captured live",
      "request.model": "Model",
      "request.provider": "Provider",
      "request.attempt": "Request within plan",
      "request.planRef": "Plan version",
      "request.messages": "Messages",
      "request.tools": "Tool declarations",
      "request.bytes": "Stored bytes",
      "request.truncated": "The request body exceeded the storage cap and was truncated; the audit is therefore insufficient.",
      "request.planTitle": "Spine plan",
      "request.planMissing": "No Spine plan was captured for this request, so nothing can be compared.",
      "request.planCell": "Plan cell",
      "request.planNoCells": "The plan has no cells.",
      "request.messagesTitle": "Frozen request",
      "request.hostLayer": "Host layer (not Spine-planned)",
      "request.hostLayerBody": "The system prompt, developer messages, and tool declarations belong to DSH; Spine does not plan them.",
      "request.differencesTitle": "Differences",
      "request.noDifferences": "No differences: every planned message reached the request once, in order, with the expected content.",
      "request.notesTitle": "Notes",
      "request.raw": "Raw evidence JSON",
      "request.expected": "Expected",
      "request.actual": "Actual",
      "request.matched": "Matched request message #{index}",
      "request.unmatched": "Not in the request",
      "request.hostSystem": "{n} system message(s)",
      "request.hostDeveloper": "{n} developer message(s)",
      "request.scopeNote": "The comparison covers the DSH-assembled frozen request, not the provider HTTP body.",
      "audit.consistent": "Consistent",
      "audit.known": "Known differences",
      "audit.unexplained": "Unexplained differences",
      "audit.insufficient": "Insufficient evidence",
      "audit.short.consistent": "consistent",
      "audit.short.known": "known",
      "audit.short.unexplained": "diff",
      "audit.short.insufficient": "n/a",
      "diff.missing-plan-message": "Planned message missing",
      "diff.unexpected-request-message": "Unplanned request message",
      "diff.content-changed": "Same identity, changed content",
      "diff.order": "Order anomaly",
      "diff.duplicate": "Duplicate message",
      "diff.anchor-presentation": "User anchor presentation",
      "diff.host-layer": "Host layer",
      "diff.truncated": "Evidence truncated",
      "diff.plan-unavailable": "No plan",
      "diff.plan-unmaterializable": "Plan not materializable",
      "summary.expected": "{n} planned",
      "summary.actual": "{n} in request",
      "summary.matched": "{n} matched",
      "summary.unexplained": "{n} unexplained",
      "footer.ledger": "Ledger: {entries} records ({archives} archives / {spawn} spawn terminals)",
      "footer.evidence": "Request evidence: {count}",
      "footer.evidenceError": "Request evidence unreadable: {message}",
      "empty.session": "No Session selected.",
    };
    //#endregion

    const AUDIT_TONE = {
      consistent: "ok",
      "known-differences": "warn",
      unexplained: "error",
      insufficient: "idle",
    };
    const AUDIT_SHORT = {
      consistent: "audit.short.consistent",
      "known-differences": "audit.short.known",
      unexplained: "audit.short.unexplained",
      insufficient: "audit.short.insufficient",
    };
    const STATUS_TONE = {
      Live: "ok",
      Opened: "idle",
      Closed: "idle",
      Compacted: "warn",
    };
    const STATUS_GLYPH = {
      Live: "●",
      Opened: "◐",
      Closed: "○",
      Compacted: "◇",
    };
    const DIFF_KEY = {
      "missing-plan-message": "diff.missing-plan-message",
      "unexpected-request-message": "diff.unexpected-request-message",
      "content-changed": "diff.content-changed",
      order: "diff.order",
      duplicate: "diff.duplicate",
      "anchor-presentation": "diff.anchor-presentation",
      "host-layer": "diff.host-layer",
      truncated: "diff.truncated",
      "plan-unavailable": "diff.plan-unavailable",
      "plan-unmaterializable": "diff.plan-unmaterializable",
    };

    function useTicker(active) {
      const [now, setNow] = useState(0);
      useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 2000);
        return () => clearInterval(timer);
      }, [active]);
      return now;
    }

    function useSpineFeed(sessionId) {
      const [state, setState] = useState({ phase: "loading", data: null, error: null, lastOk: 0, failures: 0 });
      const revision = useRef(null);
      const source = useRef(null);
      useEffect(() => {
        let stopped = false;
        let timer = 0;
        let controller = null;
        revision.current = null;
        source.current = null;
        setState({ phase: "loading", data: null, error: null, lastOk: 0, failures: 0 });
        if (sessionId === null) return undefined;
        const schedule = (milliseconds) => {
          if (!stopped) timer = setTimeout(load, milliseconds);
        };
        async function load() {
          if (stopped) return;
          controller = typeof AbortController === "function" ? new AbortController() : null;
          try {
            const params = new URLSearchParams();
            params.set("sessionId", sessionId);
            // The revision counter is local to one inspection source. Echo the
            // source generation too; the Host only honors `since` when both
            // name the same source, so a replacement revision always yields a
            // fresh baseline even when its counter starts at the same number.
            if (source.current !== null) {
              params.set("source", source.current);
              if (revision.current !== null) params.set("since", String(revision.current));
            }
            const response = await fetch(`${VIEW_ROUTE}?${params.toString()}`, {
              headers: { accept: "application/json" },
              signal: controller === null ? undefined : controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (stopped) return;
            if (payload !== null && typeof payload === "object" && payload.unchanged === true) {
              if (typeof payload.source === "string" && payload.source.length > 0) {
                source.current = payload.source;
              }
              setState((previous) => ({
                ...previous,
                phase: previous.data === null ? "loading" : "ready",
                error: null,
                lastOk: Date.now(),
                failures: 0,
              }));
            } else if (payload !== null && typeof payload === "object" && typeof payload.revision === "number") {
              revision.current = payload.revision;
              source.current = typeof payload.source === "string" && payload.source.length > 0
                ? payload.source
                : null;
              setState({ phase: "ready", data: payload, error: null, lastOk: Date.now(), failures: 0 });
            } else {
              throw new Error("unexpected response");
            }
            schedule(POLL_MS);
          } catch (error) {
            if (stopped || (error !== null && error !== undefined && error.name === "AbortError")) return;
            setState((previous) => ({
              ...previous,
              phase: previous.data === null ? "error" : "ready",
              error: messageOf(error),
              failures: previous.failures + 1,
            }));
            schedule(Math.min(5000, 1000 * Math.pow(2, Math.min(3, 1 + 1))));
          }
        }
        load();
        const onVisible = () => {
          if (document.visibilityState !== "visible") return;
          clearTimeout(timer);
          load();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
          stopped = true;
          clearTimeout(timer);
          if (controller !== null) controller.abort();
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, [sessionId]);
      return state;
    }

    function useRequestDetail(sessionId, requestId) {
      const [state, setState] = useState({ id: null, detail: null, error: null, loading: false });
      useEffect(() => {
        if (!requestId) {
          setState({ id: null, detail: null, error: null, loading: false });
          return undefined;
        }
        let stopped = false;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        setState({ id: requestId, detail: null, error: null, loading: true });
        const params = new URLSearchParams();
        params.set("sessionId", sessionId);
        params.set("id", requestId);
        fetch(`${REQUEST_ROUTE}?${params.toString()}`, {
          headers: { accept: "application/json" },
          signal: controller === null ? undefined : controller.signal,
        })
          .then((response) => response.json())
          .then((payload) => {
            if (stopped) return;
            if (payload !== null && payload !== undefined && payload.ok === true && payload.detail) {
              setState({ id: requestId, detail: payload.detail, error: null, loading: false });
            } else {
              setState({
                id: requestId,
                detail: null,
                error: payload !== null && payload !== undefined && typeof payload.reason === "string"
                  ? payload.reason
                  : "unavailable",
                loading: false,
              });
            }
          })
          .catch((error) => {
            if (stopped) return;
            setState({ id: requestId, detail: null, error: messageOf(error), loading: false });
          });
        return () => {
          stopped = true;
          if (controller !== null) controller.abort();
        };
      }, [sessionId, requestId]);
      return state;
    }

    function SpineTreePanel(props) {
      const t = props.t;
      const sessionId = props.sessionId === undefined || props.sessionId === null
        ? null
        : String(props.sessionId);
      const feed = useSpineFeed(sessionId);
      const ticker = useTicker(feed.data !== null);
      const [mode, setMode] = useState("tree");
      const [pane, setPane] = useState("list");
      const [pinned, setPinned] = useState(false);
      const [selectedNode, setSelectedNode] = useState(null);
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [selectedRequest, setSelectedRequest] = useState(null);

      const view = feed.data;
      const tree = view === null || view === undefined ? null : view.spine;
      const requests = view === null || view === undefined || !Array.isArray(view.requests) ? [] : view.requests;
      const revision = view === null || view === undefined ? 0 : view.revision;

      const cursorId = tree === null || tree === undefined ? null : tree.cursorId;
      useEffect(() => {
        if (pinned || tree === null || tree === undefined || tree.nodes.length === 0) return;
        const target = cursorId !== null && tree.nodes.some((node) => node.id === cursorId)
          ? cursorId
          : tree.nodes[0].id;
        setSelectedNode((current) => (current === target ? current : target));
      }, [pinned, revision, cursorId]);
      useEffect(() => {
        if (tree === null || tree === undefined) return;
        setSelectedNode((current) => {
          if (current === null) return current;
          if (tree.nodes.some((node) => node.id === current)) return current;
          return cursorId !== null && tree.nodes.some((node) => node.id === cursorId)
            ? cursorId
            : tree.nodes.length > 0 ? tree.nodes[0].id : null;
        });
      }, [revision]);
      useEffect(() => {
        if (requests.length === 0) {
          setSelectedRequest(null);
          return;
        }
        setSelectedRequest((current) =>
          current !== null && requests.some((request) => request.id === current)
            ? current
            : requests[requests.length - 1].id);
      }, [revision]);

      const stale = feed.lastOk > 0 && ticker > 0 && ticker - feed.lastOk > STALE_MS;
      const hostAvailable = view === null || view === undefined
        ? true
        : view.host !== undefined && view.host !== null && view.host.available === true;
      const hostReason = view === null || view === undefined || view.host === undefined || view.host === null
        ? null
        : view.host.reason ?? null;
      const hostMessage = view === null || view === undefined || view.host === undefined || view.host === null
        ? null
        : view.host.message ?? null;
      const notEnabled = view !== null && view !== undefined && !hostAvailable &&
        (hostReason === "spine-host-inactive" || hostReason === "spine-preset-inactive");

      const node = useMemo(() => {
        if (tree === null || tree === undefined || selectedNode === null) return null;
        return tree.nodes.find((entry) => entry.id === selectedNode) ?? null;
      }, [tree, selectedNode]);
      const visible = useMemo(
        () => (tree === null || tree === undefined ? [] : visibleNodes(tree.nodes, collapsed)),
        [tree, collapsed],
      );

      const selectNode = useCallback((id) => {
        setSelectedNode(id);
        setPinned(id !== cursorId);
        setPane("detail");
      }, [cursorId]);
      const toggleNode = useCallback((id) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);
      const follow = useCallback(() => {
        setPinned(false);
        if (cursorId !== null) setSelectedNode(cursorId);
        setPane("list");
      }, [cursorId]);

      const cursorRow = useRef(null);
      useEffect(() => {
        if (pinned || mode !== "tree" || cursorRow.current === null) return;
        cursorRow.current.scrollIntoView({ block: "nearest" });
      }, [pinned, mode, revision, cursorId]);

      if (sessionId === null) {
        return h("div", { className: "spt-root" }, h("style", null, CSS), h(EmptyState, { title: t("empty.session"), body: "" }));
      }

      const status = [];
      if (view === null || view === undefined) {
        status.push(pill(t("status.loading"), "idle"));
      } else if (!hostAvailable) {
        status.push(pill(t("status.unavailable"), "idle"));
      } else if (view.fault !== null && view.fault !== undefined) {
        status.push(pill(`${t("status.fault")}: ${view.fault.message}`, "error"));
      } else if (tree !== null && tree !== undefined && tree.state === "recovered") {
        status.push(pill(t("status.reconstructed"), "idle"));
      } else if (tree !== null && tree !== undefined && tree.state === "live") {
        status.push(pill(view.activity !== null && view.activity !== undefined && view.activity.sampling
          ? `${t("status.live")} · ${view.activity.label ?? ""}`
          : t("status.live"), "ok"));
      }
      if (stale || feed.error !== null) {
        status.push(pill(feed.error !== null ? t("status.disconnected") : t("status.stale"), "warn"));
      }
      if (!pinned && cursorId !== null) status.push(pill(t("status.following"), "idle"));

      return h(
        "div",
        { className: "spt-root", "data-pane": pane },
        h("style", null, CSS),
        h(
          "div",
          { className: "spt-toolbar" },
          h(
            "div",
            { className: "spt-tabs", role: "tablist" },
            tab(t("mode.tree"), mode === "tree", () => { setMode("tree"); setPane("list"); }),
            tab(t("mode.requests"), mode === "requests", () => { setMode("requests"); setPane("list"); }),
          ),
          mode === "tree"
            ? h(
                "button",
                {
                  type: "button",
                  className: "spt-button",
                  onClick: follow,
                  disabled: cursorId === null,
                  title: t("action.follow"),
                },
                `▶ ${t("action.follow")}`,
              )
            : null,
          h("div", { className: "spt-pills" }, status),
        ),
        h(
          "div",
          { className: "spt-body" },
          h("div", { className: "spt-list", role: mode === "tree" ? "tree" : undefined }, mode === "tree"
            ? renderTreeList()
            : renderRequestList()),
          mode === "tree" ? detailPane() : requestPane(),
        ),
        footer(),
      );

      function renderTreeList() {
        if (tree === null || tree === undefined || tree.state === "unavailable") {
          return h(EmptyState, {
            title: t("tree.unavailable"),
            body: tree !== null && tree !== undefined && tree.note !== null ? tree.note : "",
          });
        }
        if (visible.length === 0) {
          return h(EmptyState, { title: t("tree.empty"), body: t("tree.emptyHint") });
        }
        return visible.map((entry) => {
          const expandable = entry.childIds.length > 0;
          const expanded = !collapsed.has(entry.id);
          return h(
            "div",
            {
              key: entry.id,
              role: "treeitem",
              tabIndex: 0,
              "aria-level": entry.depth + 1,
              "aria-expanded": expandable ? String(expanded) : undefined,
              "aria-selected": entry.id === selectedNode ? "true" : "false",
              className: "spt-row",
              "data-selected": entry.id === selectedNode ? "true" : "false",
              "data-cursor": entry.cursor ? "true" : "false",
              ref: entry.cursor ? cursorRow : undefined,
              onClick: () => selectNode(entry.id),
              onKeyDown: (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                selectNode(entry.id);
              },
              title: `${entry.id} · ${entry.status}`,
            },
            expandable
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "spt-caret",
                    tabIndex: -1,
                    "aria-label": expanded ? t("action.collapse") : t("action.expand"),
                    onClick: (event) => {
                      event.stopPropagation();
                      toggleNode(entry.id);
                    },
                  },
                  expanded ? "▾" : "▸",
                )
              : h("span", { className: "spt-caretSpacer" }),
            h("span", { className: "spt-levels" }, levels(entry.depth)),
            h("span", {
              className: "spt-glyph",
              style: { color: toneColor(STATUS_TONE[entry.status]) },
              "aria-hidden": "true",
            }, STATUS_GLYPH[entry.status] ?? "•"),
            h(
              "span",
              { className: "spt-rowMain" },
              h("span", { className: "spt-rowTitle" }, nodeLabel(entry)),
              h(
                "span",
                { className: "spt-rowMeta" },
                h("span", { className: "spt-badge", "data-tone": STATUS_TONE[entry.status] ?? "idle" }, t(`nodeStatus.${entry.status.toLowerCase()}`)),
                entry.kind === "Task" ? null : h("span", { className: "spt-badge" }, t("kind.root")),
                entry.childIds.length > 0 ? h("span", { className: "spt-badge" }, `${entry.childIds.length} ↳`) : null,
                entry.memory.length > 0 ? h("span", { className: "spt-badge" }, `memory ${entry.memory.length}`) : null,
                entry.cursor ? h("span", { className: "spt-badge", "data-tone": "ok" }, "▶ cursor") : null,
              ),
            ),
          );
        });
      }

      function detailPane() {
        if (node === null) {
          return h("div", { className: "spt-detail" }, h(EmptyState, { title: t("tree.empty"), body: "" }));
        }
        return h(
          "div",
          { className: "spt-detail" },
          h("button", { type: "button", className: "spt-button spt-back", onClick: () => setPane("list") }, `← ${t("action.back")}`),
          h("h2", { className: "spt-title" }, nodeLabel(node)),
          h("div", { className: "spt-sub" }, `${node.id} · ${node.kind} · ${node.status}`),
          h("h3", { className: "spt-h" }, t("detail.overview")),
          h(
            "dl",
            { className: "spt-kv" },
            kv(t("field.kind"), node.kind === "Task" ? t("kind.task") : t("kind.root")),
            kv(t("field.status"), t(`nodeStatus.${node.status.toLowerCase()}`)),
            kv(t("field.id"), node.id),
            kv(t("field.start"), String(node.start)),
            kv(t("field.end"), node.end === null ? "—" : String(node.end)),
            kv(t("field.parent"), node.parentId ?? "—"),
            kv(t("field.children"), node.childIds.length === 0 ? "—" : node.childIds.join(", ")),
            node.cursor ? kv("cursor", "▶") : null,
          ),
          h("h3", { className: "spt-h" }, t("detail.memory")),
          node.memory.length === 0
            ? h("p", { className: "spt-note" }, t("detail.noMemory"))
            : node.memory.map((slot, index) => memoryCard(slot, index)),
          h("details", null,
            h("summary", null, t("detail.raw")),
            h("pre", { className: "spt-pre" }, JSON.stringify(node, null, 2)),
          ),
        );
      }

      function memoryCard(slot, index) {
        if (slot.kind === "user") {
          return h(
            "div",
            { className: "spt-card", key: `memory-${index}` },
            h("div", { className: "spt-cardHead" },
              h("span", { className: "spt-badge" }, t("memory.user")),
              h("span", { className: "spt-sub" }, `${t("field.boundary")} ${slot.boundary} · ${t("field.anchor")} U${slot.anchor}`),
            ),
            h("div", { className: "spt-text" }, slot.text),
          );
        }
        if (slot.kind === "summary") {
          return h(
            "div",
            { className: "spt-card", key: `memory-${index}` },
            h("div", { className: "spt-cardHead" },
              h("span", { className: "spt-badge" }, t("memory.summary")),
              h("span", { className: "spt-sub" }, `${t("field.span")} ${slot.span.start}–${slot.span.end}`),
            ),
            h("div", { className: "spt-text" }, slot.body),
          );
        }
        return h(
          "div",
          { className: "spt-card", key: `memory-${index}` },
          h("div", { className: "spt-cardHead" },
            h("span", { className: "spt-badge", "data-tone": slot.outcome === "completed" ? "ok" : "error" }, t("memory.spawn")),
            h("span", { className: "spt-badge" }, slot.outcome),
            h("span", { className: "spt-sub" }, `${t("field.span")} ${slot.span.start}–${slot.span.end}`),
          ),
          h("dl", { className: "spt-kv" },
            kv(t("field.task"), slot.taskSummary),
            slot.diagnostic === null ? null : kv(t("field.diagnostic"), slot.diagnostic),
            slot.executionRef === null ? null : kv(t("field.execution"), slot.executionRef),
          ),
          h("details", null,
            h("summary", null, t("field.prompt")),
            h("div", { className: "spt-text" }, slot.taskPrompt),
          ),
        );
      }

      function renderRequestList() {
        if (view === null || view === undefined) {
          return h(EmptyState, { title: t("status.loading"), body: "" });
        }
        if (!hostAvailable) {
          return h(EmptyState, notEnabled
            ? { title: t("unavailable.title"), body: t("unavailable.body"), hint: t("unavailable.hint") }
            : { title: t("error.title"), body: hostMessage ?? t("error.network") });
        }
        if (requests.length === 0) {
          const evidenceError = view.evidence !== null && view.evidence !== undefined && view.evidence.store === "error";
          return h(EmptyState, {
            title: t("requests.emptyTitle"),
            body: evidenceError ? `${t("requests.unavailableBody")} ${view.evidence.message ?? ""}` : t("requests.emptyBody"),
            hint: evidenceError ? null : t("requests.captureHint"),
          });
        }
        return requests.map((request) => h(
          "button",
          {
            key: request.id,
            type: "button",
            className: "spt-listRow",
            "data-selected": request.id === selectedRequest ? "true" : "false",
            onClick: () => { setSelectedRequest(request.id); setPane("detail"); },
          },
          h("span", { className: "spt-listTop" },
            h("span", { className: "spt-listTime" }, formatTime(request.at)),
            h("span", { className: "spt-badge", "data-tone": AUDIT_TONE[request.audit.status] ?? "idle" },
              `${auditGlyph(request.audit.status)} ${t(AUDIT_SHORT[request.audit.status] ?? "audit.insufficient")}`),
            request.attempt > 1 ? h("span", { className: "spt-badge" }, `×${request.attempt}`) : null,
            request.truncated ? h("span", { className: "spt-badge", "data-tone": "warn" }, "truncated") : null,
          ),
          h("span", { className: "spt-rowTitle" }, requestLabel(request)),
          h("span", { className: "spt-rowMeta" },
            request.purpose === null ? null : h("span", { className: "spt-badge" }, request.purpose),
            h("span", null, t("summary.expected", { n: request.audit.expected })),
            h("span", null, t("summary.actual", { n: request.audit.actual })),
            h("span", null, t("summary.matched", { n: request.audit.matched })),
            request.audit.unexplained > 0
              ? h("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, t("summary.unexplained", { n: request.audit.unexplained }))
              : null,
          ),
        ));
      }

      function requestPane() {
        return h(RequestInspector, {
          t,
          sessionId,
          requestId: selectedRequest,
          summary: requests.find((request) => request.id === selectedRequest) ?? null,
          onBack: () => setPane("list"),
        });
      }

      function footer() {
        if (view === null || view === undefined) return null;
        const parts = [];
        if (view.ledger !== null && view.ledger !== undefined) {
          parts.push(t("footer.ledger", {
            entries: view.ledger.entries,
            archives: view.ledger.archives,
            spawn: view.ledger.spawnTerminals,
          }));
        }
        if (view.evidence !== null && view.evidence !== undefined) {
          parts.push(view.evidence.store === "error"
            ? t("footer.evidenceError", { message: view.evidence.message ?? "" })
            : t("footer.evidence", { count: view.evidence.captured }));
        }
        if (parts.length === 0) return null;
        return h("div", {
          className: "spt-sub",
          style: {
            flex: "0 0 auto",
            padding: "5px 12px",
            borderTop: "1px solid var(--dsw-alias-border-l1)",
            fontSize: "11px",
          },
        }, parts.join(" · "));
      }
    }

    function RequestInspector(props) {
      const { t, sessionId, requestId, summary } = props;
      const detailState = useRequestDetail(sessionId, requestId);
      if (requestId === null || requestId === undefined) {
        return h("div", { className: "spt-detail" }, h(EmptyState, { title: t("request.select"), body: "" }));
      }
      if (detailState.loading) {
        return h("div", { className: "spt-detail" }, h("p", { className: "spt-note" }, t("status.loading")));
      }
      if (detailState.error !== null || detailState.detail === null) {
        return h(
          "div",
          { className: "spt-detail" },
          h("button", { type: "button", className: "spt-button spt-back", onClick: props.onBack }, `← ${t("action.back")}`),
          h(EmptyState, { title: t("error.title"), body: detailState.error ?? t("requests.unavailableBody") }),
        );
      }
      const detail = detailState.detail;
      const record = detail.record;
      const audit = record.audit;
      const effectiveSummary = summary ?? detail.summary;
      const differences = Array.isArray(audit.differences) ? audit.differences : [];
      const hostLayer = audit.hostLayer !== null && audit.hostLayer !== undefined
        ? audit.hostLayer
        : { systemMessages: 0, developerMessages: 0, toolCount: 0, toolNames: [] };
      const matchedByRequest = new Map();
      for (const cell of Array.isArray(audit.planCells) ? audit.planCells : []) {
        if (typeof cell.matchedRequestIndex === "number") matchedByRequest.set(cell.matchedRequestIndex, cell.index);
      }
      return h(
        "div",
        { className: "spt-detail" },
        h("button", { type: "button", className: "spt-button spt-back", onClick: props.onBack }, `← ${t("action.back")}`),
        h("h2", { className: "spt-title" }, formatTime(record.capturedAt)),
        h("div", { className: "spt-sub" },
          h("span", { className: "spt-badge", "data-tone": AUDIT_TONE[audit.status] ?? "idle" },
            `${auditGlyph(audit.status)} ${t(`audit.${auditKey(audit.status)}`)}`),
          " ",
          effectiveSummary !== null && effectiveSummary !== undefined
            ? `${t("summary.expected", { n: effectiveSummary.audit.expected })} · ${t("summary.actual", { n: effectiveSummary.audit.actual })} · ${t("summary.matched", { n: effectiveSummary.audit.matched })}`
            : "",
        ),
        h("h3", { className: "spt-h" }, t("request.overview")),
        h("dl", { className: "spt-kv" },
          kv(t("request.capturedAt"), new Date(record.capturedAt).toLocaleString()),
          kv(t("request.evidence"), t("request.evidence.live")),
          kv(t("request.model"), `${record.provider} / ${record.model}`),
          kv(t("request.planRef"), record.planId === null || record.planId === undefined ? "—" : `${record.planId} · ${record.attempt}`),
          kv(t("request.messages"), String(record.messages.length)),
          kv(t("request.tools"), String(record.toolNames.length)),
          kv(t("request.bytes"), formatBytes(record.bytes)),
        ),
        record.truncated ? h("p", { className: "spt-note", style: { color: "var(--dsw-alias-state-warn-primary)" } }, t("request.truncated")) : null,
        h("p", { className: "spt-note" }, t("request.scopeNote")),
        h("h3", { className: "spt-h" }, t("request.planTitle")),
        record.plan === null
          ? h("p", { className: "spt-note" }, t("request.planMissing"))
          : planCells(t, audit, record),
        h("h3", { className: "spt-h" }, t("request.differencesTitle")),
        differences.length === 0
          ? h("p", { className: "spt-note" }, t("request.noDifferences"))
          : differences.map((difference, index) => h(
              "div",
              { className: "spt-diff", key: `diff-${index}` },
              h("div", { className: "spt-diffCat" }, t(DIFF_KEY[difference.category] ?? "diff.host-layer")),
              h("div", { className: "spt-diffBody" },
                h("div", null, difference.detail),
                difference.expected === null ? null : h("div", { className: "spt-diffPreview" }, `${t("request.expected")}: ${difference.expected}`),
                difference.actual === null ? null : h("div", { className: "spt-diffPreview" }, `${t("request.actual")}: ${difference.actual}`),
              ),
            )),
        arrayOfStrings(audit.notes).length === 0 ? null : h("div", null,
          h("h3", { className: "spt-h" }, t("request.notesTitle")),
          arrayOfStrings(audit.notes).map((note, index) => h("p", { className: "spt-note", key: `note-${index}` }, note)),
        ),
        h("h3", { className: "spt-h" }, t("request.hostLayer")),
        h("p", { className: "spt-note" }, t("request.hostLayerBody")),
        h("div", { className: "spt-rowMeta" },
          h("span", { className: "spt-badge" }, t("request.hostSystem", { n: hostLayer.systemMessages })),
          h("span", { className: "spt-badge" }, t("request.hostDeveloper", { n: hostLayer.developerMessages })),
          h("span", { className: "spt-badge" }, `${t("request.tools")}: ${record.toolNames.length}`),
        ),
        record.toolNames.length === 0 ? null : h("details", null,
          h("summary", null, t("request.tools")),
          h("div", { className: "spt-rowMeta" }, record.toolNames.map((name) => h("span", { className: "spt-badge", key: name }, name))),
        ),
        h("h3", { className: "spt-h" }, t("request.messagesTitle")),
        h("div", null, record.messages.map((message, index) =>
          messageCard(t, message, index, matchedByRequest))),
        h("details", null,
          h("summary", null, t("request.raw")),
          h("pre", { className: "spt-pre" }, JSON.stringify(record, null, 2).slice(0, 200000)),
        ),
      );
    }

    function planCells(t, audit, record) {
      const cells = Array.isArray(audit.planCells) ? audit.planCells : [];
      if (cells.length === 0) return h("p", { className: "spt-note" }, t("request.planNoCells"));
      return h("div", null,
        cells.map((cell) => h(
          "div",
          { className: "spt-planRow", key: `cell-${cell.index}` },
          h("span", { className: "spt-planIndex" }, String(cell.index)),
          h("span", null,
            h("span", { className: "spt-mono" }, cell.label),
            cell.expected === null
              ? h("div", { className: "spt-note" }, cell.note ?? "—")
              : h("div", { className: "spt-diffPreview" }, `${cell.expected.role}: ${cell.expected.preview}`),
            h("div", { className: "spt-note" },
              cell.matchedRequestIndex === null
                ? t("request.unmatched")
                : t("request.matched", { index: cell.matchedRequestIndex })),
          ),
        )),
        record.planDigest === null ? null : h("div", { className: "spt-note spt-mono" }, `plan ${String(record.planDigest).slice(0, 16)}`),
      );
    }

    function messageCard(t, message, index, matchedByRequest) {
      const role = message !== null && typeof message === "object" && typeof message.role === "string"
        ? message.role
        : "unknown";
      const sourceKind = message !== null && typeof message === "object" && message.source !== null && typeof message.source === "object" && typeof message.source.kind === "string"
        ? message.source.kind
        : null;
      const hostLayer = role === "system" || role === "developer";
      const plannedCell = matchedByRequest.get(index);
      const text = messageText(message);
      return h(
        "div",
        { className: "spt-msg", key: `message-${index}` },
        h("div", { className: "spt-msgHead" },
          h("span", { className: "spt-mono" }, `#${index}`),
          h("span", { className: "spt-badge", "data-tone": hostLayer ? "idle" : role === "user" ? "ok" : "idle" }, role),
          sourceKind === null ? null : h("span", { className: "spt-badge" }, sourceKind),
          hostLayer
            ? h("span", { className: "spt-badge" }, "host")
            : plannedCell === undefined
              ? h("span", { className: "spt-badge", "data-tone": "error" }, "unplanned")
              : h("span", { className: "spt-badge", "data-tone": "ok" }, `plan #${plannedCell}`),
        ),
        text.length === 0
          ? h("div", { className: "spt-note" }, "—")
          : text.length > 4000
            ? h("details", null,
                h("summary", null, `${text.slice(0, 160).replace(/\s+/g, " ")}…`),
                h("pre", { className: "spt-pre" }, text.slice(0, 200000)),
              )
            : h("div", { className: "spt-text" }, text),
      );
    }

    function EmptyState(props) {
      return h(
        "div",
        { className: "spt-empty" },
        h("div", { className: "spt-emptyTitle" }, props.title),
        props.body === "" || props.body === null || props.body === undefined
          ? null
          : h("p", { className: "spt-emptyBody" }, props.body),
        props.hint === null || props.hint === undefined
          ? null
          : h("p", { className: "spt-emptyBody", style: { opacity: 0.8 } }, props.hint),
      );
    }

    function tab(label, selected, onClick) {
      return h("button", {
        type: "button",
        role: "tab",
        className: "spt-tab",
        "aria-selected": selected ? "true" : "false",
        onClick,
      }, label);
    }

    function pill(label, tone) {
      return h("span", { className: "spt-pill", "data-tone": tone, key: label }, label);
    }

    function kv(term, value) {
      return h(React.Fragment, { key: `${term}:${value}` }, h("dt", null, term), h("dd", null, value));
    }

    function levels(depth) {
      const nodes = [];
      for (let index = 0; index < depth; index += 1) {
        nodes.push(h("span", { className: "spt-level", key: index }));
      }
      return nodes;
    }

    function visibleNodes(nodes, collapsed) {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const output = [];
      const seen = new Set();
      const walk = (node) => {
        if (seen.has(node.id)) return;
        seen.add(node.id);
        output.push(node);
        if (collapsed.has(node.id)) return;
        for (const childId of node.childIds) {
          const child = byId.get(childId);
          if (child !== undefined) walk(child);
        }
      };
      for (const node of nodes) {
        if (node.parentId === null || !byId.has(node.parentId)) walk(node);
      }
      return output;
    }

    function nodeLabel(node) {
      if (node.summary !== null && node.summary !== undefined && node.summary !== "") return node.summary;
      if (node.kind === "RootEpoch") return `Epoch ${node.path[0] ?? "?"}`;
      return `Node ${node.id}`;
    }

    function requestLabel(request) {
      const purpose = request.purpose === null || request.purpose === undefined ? "loop" : request.purpose;
      return `${request.model} · ${purpose}`;
    }

    function auditGlyph(status) {
      if (status === "consistent") return "✓";
      if (status === "known-differences") return "Δ";
      if (status === "unexplained") return "✕";
      return "?";
    }

    function auditKey(status) {
      if (status === "consistent") return "consistent";
      if (status === "known-differences") return "known";
      if (status === "unexplained") return "unexplained";
      return "insufficient";
    }

    function toneColor(tone) {
      if (tone === "ok") return "var(--dsw-alias-state-success-primary)";
      if (tone === "warn") return "var(--dsw-alias-state-warn-primary)";
      if (tone === "error") return "var(--dsw-alias-state-error-primary)";
      return "var(--dsw-alias-state-idle-primary)";
    }

    function messageText(message) {
      if (message === null || typeof message !== "object") return String(message ?? "");
      const content = message.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      const parts = [];
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
        else if (block.type === "tool-call") parts.push(`[tool-call ${String(block.id ?? block.toolCallId ?? "")} ${String(block.name ?? "")}]`);
        else if (block.type === "tool-result") parts.push(`[tool-result ${String(block.toolCallId ?? block.id ?? "")}]`);
        else if (block.type === "image") parts.push("[image]");
        else if (typeof block.type === "string") parts.push(`[${block.type}]`);
      }
      return parts.join("\n");
    }

    function formatTime(at) {
      if (typeof at !== "number" || !Number.isFinite(at)) return "—";
      return new Date(at).toLocaleTimeString();
    }

    function formatBytes(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
      return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
    }

    function arrayOfStrings(value) {
      return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
    }

    function messageOf(error) {
      if (error instanceof Error) return error.message;
      return String(error);
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: ZH, en: EN }),
          "spine-tree: dictionaries",
        );
        const t = ctx.locale.bind(NS);
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            {
              name: "conversation.view",
              id: "spine-tree",
              order: 20,
              locale: NS,
              label: () => t("view.label"),
            },
            (props) => h(SpineTreePanel, { ...props, t }),
          ),
        );
      },
    };
  },
});
