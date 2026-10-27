import { expandToFullFile, parseUnifiedDiff } from "./diff-parser.js?v=20261027-404";
import { renderChatMessage } from "./message-renderer.js?v=20261027-404";
import { createChatContentRenderer } from "./chat-content-renderer.mjs?v=20261027-404";
import { createStableHtmlRenderer } from "./stable-html-renderer.mjs?v=20261027-404";
import { mergeAgentJob as mergeJobSnapshot, reconcileAgentJob } from "./agent-job-snapshot.mjs?v=20261027-404";
import { initializeMermaidRendering } from "./mermaid-renderer.js?v=20261027-404";
import { initializeSourceReferences } from "./source-reference-viewer.js?v=20261027-404";
import { attachmentCardMarkup } from "./context-attachment-view.mjs?v=20261027-404";
import { initializeAttachmentViewer } from "./context-attachment-viewer.mjs?v=20261027-404";
import { createPromptEditor, promptEditButton } from "./prompt-editor.js?v=20261027-404";
import { createChatRevisionViewer, revisionHistoryButton } from "./chat-revisions.mjs?v=20261027-404";
import { createPromptRevisionCoordinator } from "./prompt-revision-stop.mjs?v=20261027-404";
import { createPromptRevisionFlow } from "./prompt-revision-flow.mjs?v=20261027-404";
import { createRevisionScopePicker } from "./revision-scope-picker.mjs?v=20261027-404";
import { createStoppedPromptRecovery } from "./stopped-prompt-recovery.mjs?v=20261027-404";
import { createChatRevisionState } from "./chat-revision-state.mjs?v=20261027-404";
import { createQueuedPromptEditor, queuedPromptButtons } from "./queued-prompt-editor.js?v=20261027-404";
import { createQueuedPromptSteering, queuedSteerButtonMarkup } from "./queued-prompt-steering.mjs?v=20261027-404";
import { convertEnvironmentFormat } from "./environment-format.js?v=20261027-404";
import { buildApiCollectionTree } from "./api-collection-tree.js?v=20261027-404";
import { applyPathVariables, composeUrlWithQuery, normalizeRequestParameters, pathVariablesFromUrl, queryParametersFromUrl, requestParametersFromObject, requestParametersToObject } from "./api-request-parameters.js?v=20261027-404";
import { backupFieldsValid, normalizeBackupRepositoryUrl } from "./backup-form.js?v=20261027-404";
import { fontSizeZoom, normalizeFontSize } from "./font-size.js?v=20261027-404";
import { initializeFontFamilyPicker } from "./font-family.mjs?v=20261027-404";
import { createJsonExplorer } from "./json-explorer.js?v=20261027-404";
import { normalizeRepositoryTabGroups, normalizeRepositoryTabOrder, reconcileRepositoryTabOrder, reorderRepositoryTabs, repositoryTabLayout, REPOSITORY_TAB_GROUP_COLORS } from "./repository-tab-groups.js?v=20261027-404";
import { setupRepositoryTabDrag } from "./repository-tab-drag.mjs?v=20261027-404";
import { repositoryTabScrollState, repositoryTabRevealLeft, repositoryTabWheelDelta, repositoryTabFocusIndex } from "./repository-tab-navigation.mjs?v=20261027-404";
import { createModelSelectionStore, modelCatalogStatus, modelIdentityDescription, modelSelectionKey, modelSpeedControl, providerModelCatalog, reasoningLabel, resolveModelSelection } from "./model-selection.js?v=20261027-404";
import { initializeNexusThemePicker } from "./nexus-theme-picker.mjs?v=20261027-404";
import { setupGitPanelResize } from "./git-panel-resize.mjs?v=20261027-404";
import { createGitStashActions, initializeGitStashes } from "./git-stash.mjs?v=20261027-404";
import { gitBulkRevertSelection, validateGitBulkRevertPreview, confirmGitBulkRevert, renderGitBulkRevertNotice } from "./git-bulk-revert.mjs?v=20261027-404";
import { conversationMessagesWithCheckpoints, isCheckpointEligible, createChatCheckpointNavigation } from "./chat-checkpoints.mjs?v=20261027-404";
import { createChatCheckpointActions, checkpointButtonMarkup } from "./chat-checkpoint-actions.mjs?v=20261027-404";
import { createAgentQuestionCards, chatQuestion, latestTaskQuestion, normalizeAgentQuestion, questionCardTitle, questionWasCancelled } from "./agent-question-cards.mjs?v=20261027-404";
import { createTaskPromptNotes, createPromptNoteFields, sentPromptNotesMarkup } from "./task-prompt-notes.mjs?v=20261027-404";
import { createRepositoryIdeBridge } from "./repository-ide-bridge.mjs?v=20261027-404";
import { createDiffNavigation, renderDiffNavigationCode, resolveDiffNavigationPosition } from "./diff-navigation.mjs?v=20261027-404";
import { createAppNavigationHistory } from "./app-navigation-history.mjs?v=20261027-404";
import { createRepositoryTerminal } from "./repository-terminal.mjs?v=20261027-404";
import { createIdeRunControls } from "./ide-run-controls.mjs?v=20261027-404";
import { createRepositoryPorts } from "./repository-ports.mjs?v=20261027-404";
import { renderRepositoryContextSummary } from "./repository-context-bar.mjs?v=20261027-404";
import { createAiContextHeader } from "./ai-context-header.mjs?v=20261027-404";
import { createRepositoryTaskDrawer } from "./repository-task-drawer.mjs?v=20261027-404";
import { createProjectSyncLifecycle } from "./project-sync-lifecycle.mjs?v=20261027-404";
import { createRepositoryAiKit } from "./repository-ai-kit.mjs";
import { installChatHistoryPanels } from "./chat-history-panel.mjs";
import { buildServiceCards, createServiceCardOrder } from "./service-card-order.mjs?v=20261027-404";
import { createApiClient } from "./api-client.mjs?v=20261027-404";
import { createRuntimeStateSync } from "./runtime-state-sync.mjs?v=20261027-404";
import { formatJson, renderResponseContent } from "./api-response-renderer.mjs?v=20261027-404";
import { apiSnapshotHasContent, apiSnapshotKey, apiSnapshotRequestKey, createApiRequestHistory } from "./api-request-history.mjs?v=20261027-404";
import { historyRowsMarkup } from "./api-request-history-view.mjs?v=20261027-404";
import { initializeCompactComposers } from "./compact-composer.mjs?v=20261027-404";
import { createRepositoryCloneJobs } from "./repository-clone-jobs.mjs?v=20261027-404";
import { serviceConfigurationInput } from "./service-configuration-form.mjs?v=20261027-404";
import { createRepositoryTabSearch } from "./repository-tab-search.mjs?v=20261027-404";
import { branchPickerMarkup, createBranchPickerLoader } from "./branch-picker.mjs?v=20261027-404";
import { createDailyPlanner } from "./daily-planner.mjs?v=20261027-404";
import { createChatContextPreference } from "./chat-context-preference.mjs?v=20261027-404";
import { formatProcessLogEntry, formatProcessLogSnapshot } from "./process-log-format.mjs?v=20261027-404";
import { providerAvailability, providerCanRun, providerIsVerifiedReady, providerOptionSuffix, providerConnectionStatus, providerAvailabilitySource, providerSnapshotKey, createProviderStatusPoller } from "./provider-availability.mjs?v=20261027-404";
const API_CLIENT_REPOSITORY_ID = "standalone-api-client";
const apiRequestHistory = createApiRequestHistory({ api: (...args) => api(...args), onChange: () => renderApiRequestHistory() });
const modelSelections = createModelSelectionStore(localStorage);
const chatContextPreference = createChatContextPreference(localStorage);
const modelSelectionWrites = new Map();
const modelDraftEpochs = new Map();
const appNavigationHistory = createAppNavigationHistory(10);
let appNavigationRestoring = false, appNavigationScheduled = false, appNavigationRevision = 0;
const serviceOperations = new Map();
const repositoryPortRefreshes = new Map();
const repositoryCloneJobs = createRepositoryCloneJobs({ api: (...args) => api(...args) });
const projectSyncLifecycle = createProjectSyncLifecycle({
    refresh: repositoryId => api(`/api/repositories/${encodeURIComponent(repositoryId)}/ide/language/refresh`, { method: "POST" }),
    onError: error => toast(`Dependencies synced, but language indexing could not reload: ${error.message}`, "error"),
});
let ideRunControls, repositoryPorts, repositoryTabSearch, serviceCardOrder, serviceProcessRevision = 0;
let dailyPlanner;
let aiContextHeader;
let pendingPlannerOpen = new URLSearchParams(window.location.search).get("openDailyPlanner") === "1";
function storedCollapsedApiCollections() {
    try {
        const value = JSON.parse(localStorage.getItem("argus-collapsed-api-collections") || "[]");
        return new Set(Array.isArray(value) ? value.map(String) : []);
    }
    catch {
        return new Set();
    }
}
const state = {
    workspace: null,
    activeRepository: null,
    gitStatus: null,
    gitStatusVersion: 0,
    gitStatusPolling: null,
    gitStatusLoading: false,
    gitActionRepositories: new Set(),
    gitBulkRevertReports: new Map(),
    branches: [],
    branchesRepositoryId: null,
    processes: [],
    providers: [],
    refreshingAiProviders: new Set(),
    cliCapabilityReports: new Map(),
    cliCapabilityRequests: new Map(),
    aiConnectionsRefreshPromise: null,
    activeJob: null,
    repositoryDrafts: {},
    repositorySubmitting: {},
    repositorySubmissions: {},
    repositoryPromptQueues: {},
    repositoryJobs: [],
    globalJob: null,
    globalSubmitting: false,
    globalSubmission: null,
    globalPromptQueues: {},
    promptQueueProcessors: new Set(),
    promptQueuesLoaded: new Set(),
    promptQueueSaves: new Set(),
    promptQueueSaveRetries: new Map(),
    promptQueueHolds: new Map(),
    globalDraft: "",
    globalJobs: [],
    logTimer: null,
    logEpoch: 0,
    logRequest: null,
    logCopyRequest: null,
    activeLogConfigurationId: null,
    activeLogProcessId: null,
    logCursor: 0,
    logWrap: false,
    jobTimer: null,
    globalJobTimer: null,
    refreshToken: 0,
    detectedRuntimes: [],
    runtimeDetectionPromise: null,
    runtimeDetectionLoadedKey: "",
    runtimeDetectionCheckedAt: 0,
    apiRequests: [],
    apiCollections: [],
    apiEnvironments: [],
    activeApiEnvironmentId: localStorage.getItem("argus-active-api-environment") || "",
    editingApiEnvironmentId: null,
    activeApiRequest: null,
    apiResponse: null,
    apiResponseRequestKey: null,
    apiEditorReady: false,
    apiEditorGeneration: 0,
    apiEditorTransition: 0,
    apiActiveSend: null,
    apiHistoryLastKey: null,
    apiHistoryWrite: Promise.resolve(),
    apiHistoryFailedResponses: new Map(),
    apiHistoryPendingIds: new Set(),
    importedAgentJobs: new Set(),
    repositoryAttachments: {},
    globalAttachments: [],
    unsupportedContextRequest: null,
    pendingOnboardingRepositories: [],
    folderDiscoveryRevision: 0,
    folderDiscoveryBusy: false,
    onboardingSubmitting: false,
    pendingOffboardingIds: new Set(),
    repositoryTasks: {},
    activeTaskByRepository: {},
    globalTasks: [],
    activeGlobalTaskId: null,
    navigationReady: false,
    restoringRoute: false,
    currentView: "repository",
    processRefreshPromise: null,
    serviceProcessSignature: "",
    pollingAgent: false,
    pollingGlobalAgent: false,
    collapsedApiCollections: storedCollapsedApiCollections(),
    backupAccessAllowed: false,
    backupAccessEpoch: 0,
    backupAccessRequest: 0,
    backupAccessPending: false,
    backupStatus: null,
    backupStatusLoading: false,
    backupStatusRequest: 0,
    backupDialogRequest: 0,
    backupLoadError: "",
    backupSaving: false,
    backupRestoring: false,
    backupFolderSelecting: false,
    diffEditor: null,
    browserPairingTimer: null,
    findTarget: null,
    findSurface: null,
    findQuery: "",
    findMatchIndex: -1,
    findHighlightOverlay: null,
    findHighlightRange: null,
    findComposing: false,
    javaProject: null,
    pendingBackup: null,
    editingRepositoryTabGroupId: null,
    backgroundJobs: [],
    backgroundJobStatuses: new Map(),
    backgroundJobsInitialized: false,
    dismissedBackgroundJobs: new Set(),
    backgroundJobsMinimized: false,
    backgroundJobsExpanded: false,
    backgroundJobLogExpanded: new Map(),
    selectedGitChanges: new Set(),
    syncingDiffScroll: false,
};
const renderChatContent = createChatContentRenderer(renderChatMessage);
const renderChatMarkup = createStableHtmlRenderer({
    getKey: node => node.getAttribute?.("data-chat-render-key"),
    replaceChanged: node => node.matches?.(".chat-mermaid-block"),
});
const renderActivityMarkup = createStableHtmlRenderer({
    getKey: node => node.getAttribute?.("data-activity-key"),
});
function setTextIfChanged(element, text) {
    if (element.textContent !== text)
        element.textContent = text;
}
function mergeAgentJob(current, update, base = current) {
    return mergeJobSnapshot(current, update, base);
}
function reconcileAgentJobs(jobs, currentJobs, selected, repositoryId, knownJobIds = new Set()) {
    const latest = new Map(currentJobs.map(job => [job.id, job]));
    if (selected?.id)
        latest.set(selected.id, reconcileAgentJob(latest.get(selected.id), selected));
    const incomingIds = new Set(jobs.map(job => job.id));
    const newlyStarted = repositoryId ? [...latest.values()].filter(job => !incomingIds.has(job.id) && !knownJobIds.has(job.id)
        && job.repositoryId === repositoryId && isChatAgentJob(job) && agentJobIsActive(job)) : [];
    return [...newlyStarted, ...jobs.map(job => reconcileAgentJob(latest.get(job.id), job))];
}
function agentJobIsActive(job) {
    return Boolean(job && (["starting", "running", "paused"].includes(job.status) || job.completionPending));
}
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const branchIcon = `<svg class="branch-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2.25"></circle><circle cx="17.5" cy="6" r="2.25"></circle><circle cx="17.5" cy="18" r="2.25"></circle><path d="M6 7.25v6.5A4.25 4.25 0 0 0 10.25 18h5M8.25 6h5A4.25 4.25 0 0 1 17.5 10.25v5.5"></path></svg>`;
function visibleElement(element) {
    return Boolean(element && !element.classList.contains("hidden") && element.getClientRects().length);
}
function resolveFindContext() {
    const active = document.activeElement;
    if (active?.closest?.("#find-bar") && state.findTarget?.isConnected && state.findSurface?.isConnected)
        return { target: state.findTarget, surface: state.findSurface };
    if (active?.matches?.("textarea, input:not([type=search]), [contenteditable=true], pre")) {
        const surface = active.closest(".diff-window, .api-response-panel, .log-console, .dialog-card, .api-request-workbench") || active.parentElement;
        return { target: active, surface };
    }
    const surface = active?.closest?.(".diff-window, .api-response-panel, .log-console")
        || [...document.querySelectorAll("dialog[open]")].at(-1)?.querySelector(".diff-window, .dialog-card")
        || (visibleElement($("#log-console")) ? $("#log-console") : null);
    if (!surface)
        return null;
    const target = visibleElement(surface.querySelector("#diff-editor-text"))
        ? surface.querySelector("#diff-editor-text")
        : [...surface.querySelectorAll(".api-response-panel pre, .log-console pre, .diff-pane-scroller, .diff-split-content, textarea, [contenteditable=true]")].find(visibleElement)
            || surface;
    return { target, surface };
}
function openFindBar() {
    const context = resolveFindContext();
    if (!context?.target || !context?.surface) {
        toast("Click inside the panel you want to search");
        return;
    }
    const bar = $("#find-bar");
    clearFindHighlight();
    state.findTarget = context.target;
    state.findSurface?.classList.remove("find-surface");
    state.findSurface = context.surface;
    state.findSurface.classList.add("find-surface");
    state.findSurface.append(bar);
    state.findQuery = "";
    state.findMatchIndex = -1;
    state.findComposing = false;
    bar.classList.remove("hidden");
    findInCurrentSurface(false, { advance: false });
    $("#find-input").focus({ preventScroll: true });
    $("#find-input").select();
}
function closeFindBar() {
    const bar = $("#find-bar");
    const target = state.findTarget;
    clearFindHighlight();
    bar.classList.add("hidden");
    state.findSurface?.classList.remove("find-surface");
    document.body.append(bar);
    state.findSurface = null;
    state.findTarget = null;
    state.findComposing = false;
    if (target instanceof HTMLElement && target.isConnected)
        target.focus({ preventScroll: true });
}
function clearFindHighlight() {
    window.CSS?.highlights?.delete("argus-find-active");
    state.findHighlightOverlay?.remove();
    state.findHighlightOverlay = null;
    state.findHighlightRange = null;
}
function syncFindHighlight() {
    const target = state.findTarget;
    const overlay = state.findHighlightOverlay;
    if (!overlay || !target?.isConnected)
        return;
    const rect = target.getBoundingClientRect();
    const dialog = overlay.parentElement instanceof HTMLDialogElement ? overlay.parentElement : null;
    const origin = dialog?.getBoundingClientRect() || { left: 0, top: 0 };
    overlay.style.left = `${rect.left - origin.left}px`;
    overlay.style.top = `${rect.top - origin.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.scrollTop = target.scrollTop;
    overlay.scrollLeft = target.scrollLeft;
    if (state.findHighlightRange) {
        const scale = overlay.offsetWidth ? overlay.getBoundingClientRect().width / overlay.offsetWidth : 1;
        overlay.style.left = `${(rect.left - origin.left) / scale}px`;
        overlay.style.top = `${(rect.top - origin.top) / scale}px`;
        overlay.style.width = `${rect.width / scale}px`;
        overlay.style.height = `${rect.height / scale}px`;
        overlay.scrollTop = overlay.scrollLeft = 0;
        overlay.replaceChildren(...[...state.findHighlightRange.getClientRects()].map((matchRect) => {
            const mark = document.createElement("mark");
            mark.className = "active";
            Object.assign(mark.style, { position: "absolute", left: `${(matchRect.left - rect.left) / scale}px`, top: `${(matchRect.top - rect.top) / scale}px`, width: `${matchRect.width / scale}px`, height: `${matchRect.height / scale}px` });
            return mark;
        }));
    }
}
function highlightEditableMatches(target, source, matches, query, activeIndex) {
    clearFindHighlight();
    const overlay = document.createElement("div");
    const computed = getComputedStyle(target);
    overlay.className = "find-highlight-overlay";
    for (const property of ["font", "lineHeight", "letterSpacing", "padding", "textAlign", "textIndent", "whiteSpace", "wordBreak", "overflowWrap", "tabSize"])
        overlay.style[property] = computed[property];
    overlay.style.borderTopWidth = computed.borderTopWidth;
    overlay.style.borderRightWidth = computed.borderRightWidth;
    overlay.style.borderBottomWidth = computed.borderBottomWidth;
    overlay.style.borderLeftWidth = computed.borderLeftWidth;
    let cursor = 0;
    overlay.innerHTML = matches.map((start, index) => {
        const before = escapeHtml(source.slice(cursor, start));
        const match = escapeHtml(source.slice(start, start + query.length));
        cursor = start + query.length;
        return `${before}<mark class="${index === activeIndex ? "active" : ""}">${match}</mark>`;
    }).join("") + escapeHtml(source.slice(cursor)) + "\u200b";
    (target.closest("dialog[open]") || document.body).append(overlay);
    state.findHighlightOverlay = overlay;
    syncFindHighlight();
    const active = overlay.querySelector("mark.active");
    if (active) {
        const verticalPadding = Number.parseFloat(computed.paddingTop) || 0;
        const horizontalPadding = Number.parseFloat(computed.paddingLeft) || 0;
        target.scrollTop = Math.max(0, active.offsetTop - target.clientHeight / 3 - verticalPadding);
        target.scrollLeft = Math.max(0, active.offsetLeft - target.clientWidth / 3 - horizontalPadding);
        syncFindHighlight();
    }
}
function findTextNodes(target) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
        if (!node.parentElement?.closest("#find-bar, .find-highlight-overlay, script, style, [hidden], .hidden"))
            nodes.push(node);
    }
    return nodes;
}
function selectTextMatch(target, start, length, nodes = findTextNodes(target)) {
    let offset = 0;
    let startNode;
    let startOffset;
    let endNode;
    let endOffset;
    for (const node of nodes) {
        const next = offset + node.data.length;
        if (!startNode && start >= offset && start <= next) {
            startNode = node;
            startOffset = start - offset;
        }
        if (start + length >= offset && start + length <= next) {
            endNode = node;
            endOffset = start + length - offset;
            break;
        }
        offset = next;
    }
    if (!startNode || !endNode)
        return false;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    clearFindHighlight();
    if (window.CSS?.highlights && window.Highlight) {
        window.CSS.highlights.set("argus-find-active", new window.Highlight(range));
    }
    else {
        const overlay = document.createElement("div");
        overlay.className = "find-highlight-overlay";
        (target.closest("dialog[open]") || document.body).append(overlay);
        state.findHighlightOverlay = overlay;
        state.findHighlightRange = range;
    }
    const matchRect = range.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const scale = target.offsetWidth ? targetRect.width / target.offsetWidth : 1;
    const top = matchRect.top < targetRect.top || matchRect.bottom > targetRect.bottom
        ? (matchRect.top - targetRect.top - targetRect.height / 3) / scale : 0;
    const left = matchRect.left < targetRect.left || matchRect.right > targetRect.right
        ? (matchRect.left - targetRect.left - targetRect.width / 3) / scale : 0;
    if (top || left)
        target.scrollBy({ top, left, behavior: "instant" });
    syncFindHighlight();
    return true;
}
function findInCurrentSurface(backwards = false, { advance = true } = {}) {
    if (state.findComposing || $("#find-bar").classList.contains("hidden"))
        return;
    const input = $("#find-input");
    const query = input.value;
    if (query !== state.findQuery)
        state.findMatchIndex = -1;
    state.findQuery = query;
    if (!query) {
        clearFindHighlight();
        $("#find-status").textContent = "Type to search";
        return;
    }
    const target = state.findTarget;
    if (!target?.isConnected) {
        closeFindBar();
        return;
    }
    const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const nodes = editable ? [] : findTextNodes(target);
    const source = editable ? target.value : nodes.map((node) => node.data).join("");
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const matches = [...source.matchAll(pattern)].map((match) => match.index);
    if (!matches.length) {
        clearFindHighlight();
        state.findMatchIndex = -1;
        $("#find-status").textContent = "No results";
        return;
    }
    if (state.findMatchIndex < 0)
        state.findMatchIndex = backwards ? matches.length - 1 : 0;
    else if (advance)
        state.findMatchIndex = backwards
            ? (state.findMatchIndex <= 0 ? matches.length - 1 : state.findMatchIndex - 1)
            : (state.findMatchIndex + 1) % matches.length;
    else
        state.findMatchIndex = Math.min(state.findMatchIndex, matches.length - 1);
    const match = matches[state.findMatchIndex];
    if (editable) {
        highlightEditableMatches(target, source, matches, query, state.findMatchIndex);
    }
    else
        selectTextMatch(target, match, query.length, nodes);
    $("#find-status").textContent = `${state.findMatchIndex + 1} of ${matches.length}`;
    if (advance && document.activeElement !== input)
        input.focus({ preventScroll: true });
}
function bindFindBar() {
    document.addEventListener("keydown", (event) => {
        if (event.isComposing || state.findComposing)
            return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            openFindBar();
        }
        else if (event.key === "Escape" && !$("#find-bar").classList.contains("hidden")) {
            event.preventDefault();
            closeFindBar();
        }
        else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g" && !$("#find-bar").classList.contains("hidden")) {
            event.preventDefault();
            findInCurrentSurface(event.shiftKey);
        }
    });
    $("#find-input").addEventListener("input", (event) => { if (!event.isComposing)
        findInCurrentSurface(false, { advance: false }); });
    $("#find-input").addEventListener("compositionstart", () => { state.findComposing = true; });
    $("#find-input").addEventListener("compositionend", () => { state.findComposing = false; findInCurrentSurface(false, { advance: false }); });
    $("#find-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing && !state.findComposing) {
            event.preventDefault();
            findInCurrentSurface(event.shiftKey);
        }
    });
    $("#find-previous").addEventListener("click", () => findInCurrentSurface(true));
    $("#find-next").addEventListener("click", () => findInCurrentSurface(false));
    $("#find-close").addEventListener("click", closeFindBar);
    document.addEventListener("scroll", syncFindHighlight, true);
    window.addEventListener("resize", syncFindHighlight);
}
let runtimeStateSync;
const api = createApiClient(globalThis.fetch, { onMutation: event => runtimeStateSync?.observe(event) });
const appearancePreferenceWrites = { revision: 0, pending: Promise.resolve() };
function applyTheme(theme, persist = true) {
    const selected = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = selected;
    const button = $("#theme-toggle");
    if (button) {
        const light = selected === "light";
        button.querySelector("span").textContent = light ? "☾" : "☀";
        $("#theme-menu-label").textContent = light ? "Dark mode" : "Light mode";
        button.title = light ? "Switch to dark mode" : "Switch to light mode";
        button.setAttribute("aria-label", button.title);
    }
    if (!persist)
        return;
    try {
        localStorage.setItem("argus-theme", selected);
    }
    catch { }
    const revision = ++appearancePreferenceWrites.revision;
    appearancePreferenceWrites.pending = appearancePreferenceWrites.pending.then(async () => {
        if (revision !== appearancePreferenceWrites.revision)
            return;
        try {
            await api("/api/preferences", { method: "PATCH", body: { theme: selected } });
        }
        catch {
            if (revision === appearancePreferenceWrites.revision)
                toast("Appearance changed, but could not be saved. Choose it again to retry.", "error");
        }
    });
    return appearancePreferenceWrites.pending;
}
function applyFontSize(fontSize, persist = true) {
    const selected = normalizeFontSize(fontSize);
    const zoom = fontSizeZoom(selected);
    document.documentElement.dataset.fontSize = selected;
    $$('[data-font-size]').forEach((button) => {
        const active = button.dataset.fontSize === selected;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    });
    if (window.argusDesktop?.setZoomFactor) {
        document.body.style.removeProperty("zoom");
        window.argusDesktop.setZoomFactor(zoom);
    }
    else {
        document.body.style.zoom = String(zoom);
    }
    if (!persist)
        return;
    localStorage.setItem("argus-font-size", selected);
    api("/api/preferences", { method: "PATCH", body: { fontSize: selected } }).catch(() => { });
}
function setTaskPanelCollapsed(scope, collapsed, persist = true) {
    const container = scope === "global" ? $(".global-codex-layout") : $(".ai-canvas");
    if (!container)
        return;
    const history = $(scope === "global" ? "#global-context-sidebar" : "#repository-task-sidebar");
    if (history?.classList.contains("chat-history-popover")) {
        history.inert = false;
        if (collapsed && history.matches(":popover-open"))
            history.hidePopover();
        if (!collapsed && !history.matches(":popover-open"))
            history.showPopover();
        container.classList.add("task-panel-collapsed");
        return;
    }
    if (!collapsed) {
        if (!closeOpenDialogs())
            return;
        $("#app-menu").open = false;
        setVersionControlDockOpen(false, false);
    }
    if (scope === "global") {
        const sidebar = $("#global-context-sidebar");
        if (collapsed && sidebar?.contains(document.activeElement))
            $("#nexus-sidebar-toggle")?.focus({ preventScroll: true });
        if (sidebar)
            sidebar.inert = collapsed;
    }
    container.classList.toggle("task-panel-collapsed", collapsed);
    $$(`[data-task-panel-toggle="${scope}"]`).forEach((button) => {
        button.setAttribute("aria-expanded", String(!collapsed));
        if (scope === "global") {
            button.title = `${collapsed ? "Show" : "Hide"} task history and connected services`;
            button.setAttribute("aria-label", button.title);
        }
        if (button.classList.contains("task-panel-rail"))
            button.title = `Open ${scope === "global" ? "global" : "local"} tasks`;
    });
    if (persist && !(scope === "repository" && document.body.classList.contains("repository-ide-enabled")))
        localStorage.setItem(`argus-${scope}-tasks-panel`, collapsed ? "collapsed" : "open");
    syncWorkspaceRail();
}
function versionControlAvailable() {
    return Boolean(state.activeRepository && state.currentView === "repository"
        && document.body.classList.contains("repository-ide-enabled")
        && !document.body.classList.contains("workspace-tool-active"));
}
function setVersionControlDockOpen(open, persist = true) {
    const available = versionControlAvailable();
    if (open && !available) {
        document.body.classList.remove("version-control-dock-open");
        syncWorkspaceRail();
        return;
    }
    const nextOpen = Boolean(open && available);
    if (nextOpen && !closeOpenDialogs())
        return;
    document.body.classList.toggle("version-control-dock-open", nextOpen);
    if (nextOpen) {
        $("#app-menu").open = false;
        setTaskPanelCollapsed("repository", true, false);
    }
    if (persist && available)
        localStorage.setItem("argus-version-control-panel", nextOpen ? "open" : "collapsed");
    syncWorkspaceRail();
    if (nextOpen)
        void refreshVisibleGitStatus();
    if (persist)
        queueAppNavigation();
}
function activeTaskPanelScope() {
    if (!state.workspace?.repositories?.length)
        return null;
    if (state.currentView === "global")
        return "global";
    if (document.body.classList.contains("workspace-tool-active") && state.activeRepository)
        return "repository";
    return state.currentView === "repository" ? "repository" : null;
}
function syncWorkspaceRail() {
    const hasRepositories = Boolean(state.workspace?.repositories?.length);
    document.body.classList.toggle("repository-workspace-empty", !hasRepositories);
    if (!versionControlAvailable())
        document.body.classList.remove("version-control-dock-open");
    repositoryIdeBridge.syncVersionControlState();
    const scope = activeTaskPanelScope();
    const taskContextVisible = state.currentView === "repository"
        && Boolean(state.activeRepository)
        && !document.body.classList.contains("workspace-tool-active");
    document.body.classList.toggle("task-context-visible", taskContextVisible);
    syncRepositoryPorts();
    const button = $("#workspace-task-rail-toggle");
    if (!button)
        return;
    const container = scope === "global" ? $(".global-codex-layout") : scope === "repository" ? $(".ai-canvas") : null;
    const taskViewActive = (scope === "global" ? state.currentView === "global" : scope === "repository" && state.currentView === "repository")
        && !document.body.classList.contains("version-control-dock-open");
    const expanded = Boolean(taskViewActive && container && !container.classList.contains("task-panel-collapsed"));
    button.classList.toggle("hidden", !scope);
    button.classList.toggle("active", expanded);
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `${expanded ? "Close" : "Open"} ${scope === "global" ? "global" : "local"} task history`);
    const versionControlOpen = document.body.classList.contains("version-control-dock-open");
    ;
    const plannerButton = $("#daily-planner-toggle");
    const plannerOpen = state.currentView === "daily-planner";
    plannerButton?.classList.toggle("active", plannerOpen);
    plannerButton?.setAttribute("aria-expanded", String(plannerOpen));
    if (plannerOpen)
        plannerButton?.setAttribute("aria-current", "page");
    else
        plannerButton?.removeAttribute("aria-current");
    const canvasButton = $("#diagram-studio-rail-toggle");
    const canvasOpen = state.currentView === "diagrams";
    canvasButton?.classList.toggle("active", canvasOpen);
    canvasButton?.setAttribute("aria-expanded", String(canvasOpen));
    if (canvasOpen)
        canvasButton?.setAttribute("aria-current", "page");
    else
        canvasButton?.removeAttribute("aria-current");
}
function syncRepositoryWorkspacePresence() {
    const activeRepositoryExists = Boolean(state.activeRepository
        && state.workspace?.repositories?.some((repository) => repository.id === state.activeRepository.id));
    $("#workspace").classList.toggle("hidden", !activeRepositoryExists);
    $("#empty-state").classList.toggle("hidden", activeRepositoryExists);
    syncWorkspaceRail();
}
function initializeDockedPanels() {
    const menu = $("#app-menu");
    document.body.dataset.view = state.currentView;
    menu.open = false;
    localStorage.setItem("argus-tools-panel", "collapsed");
    const taskPanelMigration = localStorage.getItem("argus-task-panel-layout-v2") !== "ready";
    if (taskPanelMigration) {
        localStorage.setItem("argus-repository-tasks-panel", "open");
        localStorage.setItem("argus-task-panel-layout-v2", "ready");
    }
    setTaskPanelCollapsed("repository", true, false);
    setTaskPanelCollapsed("global", localStorage.getItem("argus-global-tasks-panel") === "collapsed", false);
    setVersionControlDockOpen(false, false);
    syncWorkspaceRail();
}
function launchWorkspaceTool(action) {
    if (!closeOpenDialogs())
        return;
    setWorkspaceToolsOpen(false);
    return action();
}
function syncWorkspaceToolsOverlay() {
    const menu = $("#app-menu");
    const summary = menu.querySelector("summary");
    summary.setAttribute("aria-expanded", String(menu.open));
    summary.setAttribute("aria-label", `${menu.open ? "Close" : "Open"} workspace tools`);
    try {
        localStorage.setItem("argus-tools-panel", menu.open ? "open" : "collapsed");
    }
    catch { }
}
function setWorkspaceToolsOpen(open, { returnFocus = false } = {}) {
    const menu = $("#app-menu");
    menu.open = Boolean(open);
    syncWorkspaceToolsOverlay();
    if (menu.open)
        void pollServiceProcesses();
    if (!menu.open && returnFocus)
        menu.querySelector("summary").focus({ preventScroll: true });
}
function showWorkspaceTools() {
    setWorkspaceToolsOpen(true);
    return true;
}
function bindWorkspaceToolsMenu() {
    const menu = $("#app-menu");
    menu.querySelector("summary").addEventListener("click", (event) => {
        event.preventDefault();
        if (menu.open)
            setWorkspaceToolsOpen(false);
        else
            showWorkspaceTools();
    });
    menu.addEventListener("toggle", syncWorkspaceToolsOverlay);
    $("#workspace-tools-close").addEventListener("click", () => setWorkspaceToolsOpen(false, { returnFocus: true }));
    document.addEventListener("pointerdown", (event) => {
        if (menu.open && !menu.contains(event.target))
            setWorkspaceToolsOpen(false);
    }, true);
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !menu.open
            || document.querySelector("dialog:modal, [popover]:popover-open"))
            return;
        event.preventDefault();
        event.stopPropagation();
        setWorkspaceToolsOpen(false, { returnFocus: true });
    }, true);
    syncWorkspaceToolsOverlay();
}
function showTaskWorkspace(scope) {
    if (!state.workspace?.repositories?.length)
        return false;
    const view = scope === "global" ? "global" : "repository";
    if (!switchPrimaryView(view))
        return false;
    setVersionControlDockOpen(false, false);
    return true;
}
function toast(message, type = "success") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.textContent = typeof message === "string" && message.trim() ? message : type === "error" ? "Argus could not complete that action. Please retry." : "Done";
    $("#toast-stack").append(element);
    setTimeout(() => element.remove(), 4000);
}
function toastAction(message, label, url) {
    const element = document.createElement("div");
    element.className = "toast action-toast";
    const text = document.createElement("span");
    text.textContent = message;
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = label;
    element.append(text, link);
    $("#toast-stack").append(element);
    setTimeout(() => element.remove(), 15000);
}
function skeletonRows(count = 5, compact = false) {
    return `<div class="skeleton-list" aria-label="Loading" aria-busy="true">${Array.from({ length: count }, () => `<div class="skeleton-row ${compact ? "compact" : ""}">${compact ? "" : '<span class="skeleton-block"></span>'}<span class="skeleton-lines"><span></span><span></span></span></div>`).join("")}</div>`;
}
function skeletonCards(count = 3) {
    return `<div class="skeleton-card-grid" aria-label="Loading services" aria-busy="true">${Array.from({ length: count }, () => `<div class="skeleton-card"><span class="skeleton-lines"><span></span><span></span></span><span class="skeleton-lines"><span></span><span></span></span><span class="skeleton-lines"><span></span><span></span></span></div>`).join("")}</div>`;
}
function formatBackupSize(bytes) {
    if (!Number(bytes))
        return "—";
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 ** 2)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function setBackupAccess(allowed) {
    state.backupAccessAllowed = allowed === true;
    const button = $("#backup-toggle");
    button.hidden = !state.backupAccessAllowed;
    button.disabled = !state.backupAccessAllowed;
    button.classList.toggle("hidden", !state.backupAccessAllowed);
    if (!state.backupAccessAllowed) {
        state.backupAccessEpoch = (state.backupAccessEpoch || 0) + 1;
        state.backupAccessRequest = (state.backupAccessRequest || 0) + 1;
        state.backupStatus = null;
        state.backupAccessPending = false;
        state.backupStatusLoading = false;
        state.backupLoadError = "";
        state.backupStatusRequest = (state.backupStatusRequest || 0) + 1;
        state.backupDialogRequest = (state.backupDialogRequest || 0) + 1;
        setRefreshLoading($("#refresh-backup-status"), false);
        state.pendingBackup = null;
        state.backupDraftRepositoryUrl = null;
        state.backupDraftDriveDirectory = null;
        $("#backup-repository-url").value = "";
        $("#backup-passphrase").value = "";
        $("#backup-passphrase").required = true;
        $("#backup-passphrase").setAttribute("aria-required", "true");
        $("#backup-passphrase").placeholder = "At least 12 characters";
        $("#backup-passphrase-requirement").textContent = "Required";
        $("#backup-passphrase-requirement").classList.remove("stored");
        $("#backup-passphrase-help").textContent = "";
        $("#backup-drive-directory").textContent = "Not configured";
        for (const id of ["backup-change-count", "backup-diff-summary", "backup-confirm-local", "backup-confirm-local-step", "backup-confirm-code-step", "backup-confirm-drive", "backup-confirm-drive-step", "backup-confirm-remote"])
            $("#" + id).textContent = "";
        for (const id of ["backup-last-result", "backup-confirm-result"]) {
            $("#" + id).innerHTML = "";
            $("#" + id).classList.add("hidden");
        }
        for (const id of ["backup-dialog", "backup-confirm-dialog"])
            if ($("#" + id).open)
                $("#" + id).close();
        $$('[data-storage-category="backupRepository"]').forEach((card) => card.remove());
        if ((state.backgroundJobs || []).some((job) => job.type === "backup-sync")) {
            state.backgroundJobs = ownerVisibleBackgroundJobs(state.backgroundJobs);
            renderBackgroundJobs();
        }
    }
    updateBackupFormValidity();
    return state.backupAccessAllowed;
}
async function refreshBackupAccess() {
    const request = state.backupAccessRequest = (state.backupAccessRequest || 0) + 1;
    state.backupAccessPending = true;
    updateBackupFormValidity();
    try {
        const access = await api("/api/backup/access", { dedupe: false, cache: "no-store" });
        if (request !== state.backupAccessRequest)
            return false;
        return setBackupAccess(access?.allowed === true);
    }
    catch {
        if (request === state.backupAccessRequest)
            setBackupAccess(false);
        return false;
    }
    finally {
        if (request === state.backupAccessRequest) {
            state.backupAccessPending = false;
            updateBackupFormValidity();
        }
    }
}
function backupAccessCurrent(epoch = state.backupAccessEpoch, error) {
    if (error?.status === 403)
        setBackupAccess(false);
    return state.backupAccessAllowed === true && epoch === state.backupAccessEpoch;
}
function ownerVisibleBackgroundJobs(jobs) {
    return jobs.filter((job) => job.type !== "backup-sync" || backupAccessCurrent());
}
function backupOperationActive() {
    return Boolean(state.backupSaving || state.backupRestoring || state.backupConfirming || state.backupStatus?.syncing
        || (state.backgroundJobs || []).some((job) => ["backup-sync", "repository-offboarding"].includes(job.type) && backgroundJobIsActive(job)));
}
function backupSettingsUnresolved() {
    return Boolean(!state.backupStatus || state.backupAccessPending || state.backupStatusLoading || state.backupLoadError);
}
function updateBackupLoadingState() {
    const allowed = backupAccessCurrent();
    const loading = Boolean(state.backupAccessPending || state.backupStatusLoading);
    const failed = Boolean(allowed && state.backupLoadError && !loading);
    const banner = $("#backup-loading-status");
    banner.classList.toggle("hidden", !loading && !failed);
    banner.classList.toggle("error", failed);
    $("#backup-loading-spinner").classList.toggle("hidden", !loading);
    $("#backup-settings-fields").setAttribute("aria-busy", String(loading));
    $("#backup-loading-title").textContent = failed ? "Couldn’t load backup settings" : state.backupAccessPending ? "Checking backup access…" : state.backupStatus ? "Refreshing backup settings…" : "Loading backup settings…";
    $("#backup-loading-detail").textContent = failed
        ? `${state.backupLoadError} ${state.backupStatus ? "Your entries are kept. Retry to check the latest settings before saving." : "Retry to check your repository, Keychain passphrase, and Google Drive folder."}`
        : state.backupAccessPending ? "Confirming access to this Mac’s backup settings."
            : state.backupStatus ? "Your entries are kept while Argus checks the latest saved settings."
                : "Checking your saved repository, Keychain passphrase, and Google Drive folder.";
    $("#retry-backup-status").classList.toggle("hidden", !failed);
    $("#retry-backup-status").disabled = !failed;
    if (allowed && backupSettingsUnresolved()) {
        const label = failed ? "Unavailable" : "Checking…";
        $("#backup-passphrase-requirement").textContent = label;
        $("#backup-passphrase-requirement").classList.remove("stored");
        $("#backup-passphrase-help").textContent = failed ? "Keychain status could not be checked. Retry loading settings." : "Checking whether a recovery passphrase is saved in this Mac’s Keychain…";
        $("#backup-passphrase").required = false;
        $("#backup-passphrase").setAttribute("aria-required", "false");
        $("#backup-passphrase").placeholder = failed ? "Settings unavailable" : "Checking saved passphrase…";
        $("#backup-drive-requirement").textContent = label;
        if (!state.backupStatus && !state.backupFolderSelecting) {
            $("#backup-drive-directory").textContent = failed ? "Settings unavailable" : "Loading folder…";
            $("#backup-change-count").textContent = failed ? "Unavailable" : "Checking…";
            $("#backup-diff-summary").textContent = failed ? "Changes could not be loaded. Retry loading backup settings." : "Loading local Git changes…";
        }
    }
    else if (allowed) {
        const stored = Boolean(state.backupStatus.hasRecoveryPassphrase);
        $("#backup-passphrase").required = !stored;
        $("#backup-passphrase").setAttribute("aria-required", String(!stored));
        $("#backup-passphrase").placeholder = stored ? "Stored securely in macOS Keychain" : "At least 12 characters";
        $("#backup-passphrase-requirement").textContent = stored ? "Saved in Keychain" : "Required";
        $("#backup-passphrase-requirement").classList.toggle("stored", stored);
        $("#backup-passphrase-help").textContent = stored ? "Saved securely in this Mac’s Keychain. Leave blank to reuse it, or enter 12+ characters to replace it." : "Required for the first backup. Use at least 12 characters and store it somewhere safe.";
        $("#backup-drive-requirement").textContent = "Required";
    }
}
function updateBackupDestinationState(busy) {
    const repository = $("#backup-repository-url");
    const value = repository.value.trim();
    const savedValue = (state.backupStatus?.repositoryUrl || "").trim();
    let normalized = "", invalid = false;
    if (value) {
        try {
            normalized = normalizeBackupRepositoryUrl(value);
        }
        catch {
            invalid = true;
        }
    }
    const verified = Boolean(normalized && normalized === savedValue && state.backupStatus?.gitAccessConfirmed);
    const requirement = $("#backup-repository-requirement");
    const unresolved = backupAccessCurrent() && backupSettingsUnresolved();
    requirement.textContent = unresolved ? state.backupLoadError && !state.backupStatusLoading && !state.backupAccessPending ? "Unavailable" : "Checking…" : busy ? "Temporarily locked" : !value ? "Required" : invalid ? "Invalid URL" : verified ? "Access verified" : "Not verified";
    requirement.classList.toggle("stored", verified && !busy);
    const help = unresolved ? state.backupLoadError ? "Saved repository status is unavailable. Retry loading settings before saving." : "Checking the saved backup repository and its last access check…" : busy
        ? "Wait for the current backup, confirmation, restore, or offboarding operation before changing backup settings."
        : !value
            ? "Paste the dedicated backup repository's clone URL, Git remote browser link, or git clone command."
            : invalid
                ? "Enter an HTTPS or SSH clone URL without credentials or extra arguments. Git remote links must identify one repository."
                : normalized !== value
                    ? `Will use ${normalized}. Access is checked before saving.`
                    : verified
                        ? "This destination passed its last access check. It will be checked again before saving."
                        : value !== savedValue
                            ? "Destination changed. Access will be checked before saving."
                            : "Access has not been verified. Check the destination; Argus will verify it before saving.";
    $("#backup-repository-help").textContent = help;
    repository.title = help;
    repository.classList.toggle("field-invalid", !unresolved && (!value || invalid));
    repository.placeholder = unresolved ? state.backupLoadError ? "Settings unavailable" : "Loading backup repository…" : "git@your-git-host:your-account/argus-backup.git";
    repository.readOnly = busy;
    repository.setAttribute("aria-readonly", String(busy));
}
function updateBackupFormValidity() {
    const repository = $("#backup-repository-url");
    const passphrase = $("#backup-passphrase");
    const driveDirectory = selectedBackupDriveDirectory();
    const hasStoredPassphrase = Boolean(state.backupStatus?.hasRecoveryPassphrase);
    const unresolved = backupSettingsUnresolved();
    const busy = !backupAccessCurrent() || unresolved || backupOperationActive();
    const valid = !busy && Boolean(repository.value.trim() && driveDirectory) && backupFieldsValid({ repositoryUrl: repository.value, driveDirectory, passphrase: passphrase.value, hasRecoveryPassphrase: hasStoredPassphrase });
    updateBackupDestinationState(busy);
    $("#choose-backup-folder").classList.toggle("field-invalid", !unresolved && !driveDirectory);
    passphrase.classList.toggle("field-invalid", !unresolved && Boolean(passphrase.value) && passphrase.value.length < 12);
    passphrase.disabled = busy;
    $("#choose-backup-folder").disabled = busy || state.backupFolderSelecting;
    $("#restore-argus-backup").disabled = busy;
    $("#save-argus-backup").disabled = !valid;
    $("#refresh-backup-status").disabled = !backupAccessCurrent() || state.backupAccessPending || state.backupStatusLoading;
    $("#backup-confirm-submit").disabled = !backupAccessCurrent() || busy;
    $("#backup-confirm-back").disabled = !backupAccessCurrent() || state.backupSaving;
    updateBackupDriveState();
    updateBackupLoadingState();
    return valid;
}
function updateBackupDriveState() {
    const status = state.backupStatus || {};
    if (backupAccessCurrent() && backupSettingsUnresolved()) {
        $("#backup-drive-label").textContent = state.backupStatus || state.backupLoadError ? "Google Drive folder" : "Checking Google Drive folder…";
        $("#backup-drive-help").textContent = state.backupLoadError ? "Folder settings could not be checked. Retry loading settings." : "Checking the saved folder and Google Drive for Desktop…";
        return;
    }
    const changed = state.backupDraftDriveDirectory != null && state.backupDraftDriveDirectory !== status.driveDirectory;
    const detected = !changed && status.driveAutoDetected;
    $("#backup-drive-label").textContent = changed ? "Selected Google Drive folder" : detected ? "Google Drive detected" : "Choose Google Drive folder";
    $("#backup-drive-help").textContent = changed
        ? "This folder is selected for your next backup. Settings are saved only after confirmation."
        : detected
            ? `Detected from Google Drive for Desktop${status.driveAccount ? ` · ${status.driveAccount}` : ""}. Click above only if you want a different folder.`
            : status.driveDetectionAmbiguous
                ? "More than one Google Drive account is mounted. Choose the My Drive folder you want Argus to use."
                : "Argus uses Google Drive for Desktop and can detect its local My Drive folder automatically.";
}
function renderBackupStatus(status) {
    if (!backupAccessCurrent())
        return;
    state.backupStatus = status;
    state.backupStatusLoading = false;
    state.backupLoadError = "";
    $("#backup-repository-url").value = state.backupDraftRepositoryUrl ?? status.repositoryUrl ?? "";
    $("#backup-git-destination").classList.remove("hidden");
    if (!state.backupFolderSelecting)
        $("#backup-drive-directory").textContent = (state.backupDraftDriveDirectory ?? status.driveDirectory) || "Not configured";
    const changes = status.changedFiles || [];
    $("#backup-change-count").textContent = `${status.branch || "unknown branch"} · ${changes.length ? `${changes.length} changed file${changes.length === 1 ? "" : "s"}` : "everything is saved locally"}`;
    const details = [
        changes.length ? changes.join("\n") : "No local Git changes.",
        `\nCodebase payload\n${status.sourceFileCount || 0} readable Argus source files from ${status.sourceRoot || "the packaged source bundle"}.`,
        "\nGit scope\nSave Argus Changes commits the dedicated Argus Backup Repository. It does not stage, commit, or clear changes in a connected source repository such as /Documents/argus.",
        status.diffSummary ? `\nDiff summary\n${status.diffSummary}` : "",
    ].join("").trim();
    $("#backup-diff-summary").textContent = details;
    if (status.lastBackup) {
        $("#backup-last-result").classList.remove("hidden");
        $("#backup-last-result").innerHTML = `<span>✓</span><div><strong>Last encrypted backup</strong><small>${escapeHtml(new Date(status.lastBackup.createdAt).toLocaleString())} · ${escapeHtml(formatBackupSize(status.lastBackup.sizeBytes))}</small></div>`;
    }
    else
        $("#backup-last-result").classList.add("hidden");
    updateBackupFormValidity();
}
async function refreshBackupStatus() {
    if (!backupAccessCurrent())
        return null;
    const epoch = state.backupAccessEpoch;
    const request = state.backupStatusRequest = (state.backupStatusRequest || 0) + 1;
    const dialogRequest = state.backupDialogRequest;
    state.backupStatusLoading = true;
    state.backupLoadError = "";
    const button = $("#refresh-backup-status");
    setRefreshLoading(button, true);
    updateBackupFormValidity();
    try {
        const status = await api("/api/backup/status", { dedupe: false, cache: "no-store" });
        if (request !== state.backupStatusRequest || dialogRequest !== state.backupDialogRequest || !backupAccessCurrent(epoch))
            return null;
        renderBackupStatus(status);
        return status;
    }
    catch (error) {
        if (request === state.backupStatusRequest && dialogRequest === state.backupDialogRequest && backupAccessCurrent(epoch, error))
            state.backupLoadError = error.message || "The request failed.";
        return null;
    }
    finally {
        if (request === state.backupStatusRequest && dialogRequest === state.backupDialogRequest) {
            state.backupStatusLoading = false;
            setRefreshLoading(button, false);
            updateBackupFormValidity();
        }
    }
}
async function openBackupDialog() {
    const request = state.backupDialogRequest = (state.backupDialogRequest || 0) + 1;
    state.backupStatusRequest = (state.backupStatusRequest || 0) + 1;
    state.backupStatusLoading = true;
    state.backupLoadError = "";
    const shownBeforeAccess = backupAccessCurrent();
    if (shownBeforeAccess && showAppDialog("backup-dialog") === false) {
        closeBackupDialog();
        return;
    }
    const allowed = await refreshBackupAccess();
    if (request !== state.backupDialogRequest)
        return;
    if (shownBeforeAccess && !$("#backup-dialog").open) {
        closeBackupDialog();
        return;
    }
    if (!allowed) {
        state.backupStatusLoading = false;
        updateBackupFormValidity();
        return;
    }
    if (!shownBeforeAccess && showAppDialog("backup-dialog") === false) {
        closeBackupDialog();
        return;
    }
    await refreshBackupStatus();
}
function closeBackupDialog() {
    state.backupDialogRequest = (state.backupDialogRequest || 0) + 1;
    state.backupStatusRequest = (state.backupStatusRequest || 0) + 1;
    state.backupStatusLoading = false;
    setRefreshLoading($("#refresh-backup-status"), false);
    updateBackupFormValidity();
}
async function chooseBackupFolder() {
    if (!backupAccessCurrent())
        return;
    if (backupSettingsUnresolved())
        return;
    if (backupOperationActive() || state.backupFolderSelecting)
        return;
    const epoch = state.backupAccessEpoch;
    const button = $("#choose-backup-folder");
    const previousDirectory = selectedBackupDriveDirectory();
    state.backupFolderSelecting = true;
    button.disabled = true;
    $("#backup-drive-directory").textContent = "Finder is open — choose your Google Drive folder…";
    updateBackupFormValidity();
    try {
        const result = await api("/api/system/select-backup-folder", { method: "POST", timeout: 0 });
        if (!backupAccessCurrent(epoch))
            return;
        if (!result.cancelled)
            state.backupDraftDriveDirectory = result.path;
        $("#backup-drive-directory").textContent = result.cancelled ? (previousDirectory || "Not configured") : result.path;
    }
    catch (error) {
        if (!backupAccessCurrent(epoch, error))
            return;
        $("#backup-drive-directory").textContent = previousDirectory || "Not configured";
        toast(error.message, "error");
    }
    finally {
        state.backupFolderSelecting = false;
        updateBackupFormValidity();
    }
}
function backupFormDraft() {
    let repositoryUrl = $("#backup-repository-url").value.trim();
    if (repositoryUrl) {
        try {
            repositoryUrl = normalizeBackupRepositoryUrl(repositoryUrl);
        }
        catch { }
    }
    const driveDirectory = selectedBackupDriveDirectory();
    const passphrase = $("#backup-passphrase").value;
    return { repositoryUrl, driveDirectory, passphrase };
}
function selectedBackupDriveDirectory() {
    const driveText = $("#backup-drive-directory").textContent;
    return ["Not configured", "Loading folder…", "Settings unavailable"].includes(driveText) || driveText.startsWith("Finder is open") ? "" : driveText;
}
function toggleBackupPreview() {
    const preview = $(".backup-preview");
    const expanded = preview.classList.toggle("expanded");
    const button = $("#toggle-backup-preview");
    button.textContent = expanded ? "Collapse" : "Expand";
    button.setAttribute("aria-expanded", String(expanded));
    if (expanded)
        $("#backup-diff-summary").focus();
}
function setBackupConfirmationStep(step, status, label) {
    const item = $(`[data-backup-step="${step}"]`);
    item.classList.remove("running", "complete", "warning", "failed", "skipped");
    if (status)
        item.classList.add(status);
    item.querySelector("em").textContent = label;
}
async function openBackupConfirmation() {
    if (!backupAccessCurrent())
        return;
    if (backupSettingsUnresolved())
        return;
    if (backupOperationActive())
        return toast("Wait for the current operation before starting another backup.", "error");
    const epoch = state.backupAccessEpoch;
    const draft = backupFormDraft();
    if (!updateBackupFormValidity()) {
        const invalidRepository = $("#backup-repository-url").classList.contains("field-invalid");
        if (invalidRepository)
            $("#backup-repository-url").focus();
        else if (!draft.driveDirectory)
            $("#choose-backup-folder").focus();
        else
            $("#backup-passphrase").focus();
        return toast(invalidRepository && draft.repositoryUrl ? "Enter a valid backup repository clone URL without credentials or extra arguments" : !draft.repositoryUrl || !draft.driveDirectory ? "Both a Git remote repository and Google Drive folder are required" : "Enter a recovery passphrase with at least 12 characters", "error");
    }
    state.backupConfirming = true;
    updateBackupFormValidity();
    try {
        const confirmation = await api("/api/backup/confirmation", { method: "POST", body: draft });
        if (!backupAccessCurrent(epoch))
            return;
        state.pendingBackup = { ...draft, confirmationId: confirmation.confirmationId };
        const localDirectory = state.backupStatus?.localDirectory || "Argus Backup Repository";
        $("#backup-confirm-local").textContent = localDirectory;
        $("#backup-confirm-local-step").textContent = `Store argus-backup.enc and manifest.json in ${localDirectory}.`;
        $("[data-backup-step=\"code\"]").classList.remove("hidden");
        $("[data-backup-step=\"git\"]").classList.remove("hidden");
        $("#backup-confirm-code-step").textContent = `Prepare ${confirmation.plan.sourceFileCount} readable source files for Git remote main. Encrypt ${confirmation.plan.privateDataEntries.length} Argus data areas, including chats, boards and repository settings.`;
        $("#backup-confirm-drive").textContent = `${confirmation.plan.driveDestination} · exact Git remote mirror`;
        $("#backup-confirm-drive-step").textContent = "After Git remote succeeds, atomically replace Drive with this one latest readable-code + encrypted-private-data snapshot.";
        ["code", "collect", "encrypt", "local", "drive", "git"].forEach((step) => setBackupConfirmationStep(step, "", "Ready"));
        $("#backup-confirm-result").className = "backup-confirm-result hidden";
        $("#backup-confirm-result").textContent = "";
        $("#backup-confirm-submit").classList.remove("hidden");
        $("#backup-confirm-done").classList.add("hidden");
        $("#backup-confirm-back").disabled = false;
        showAppDialog("backup-confirm-dialog");
    }
    catch (error) {
        if (backupAccessCurrent(epoch, error))
            toast(error.message, "error");
    }
    finally {
        state.backupConfirming = false;
        updateBackupFormValidity();
    }
}
async function saveArgusChanges() {
    if (!backupAccessCurrent())
        return;
    if (backupSettingsUnresolved())
        return;
    if (backupOperationActive())
        return toast("Wait for the current operation before starting another backup.", "error");
    const epoch = state.backupAccessEpoch;
    const button = $("#backup-confirm-submit");
    const draft = state.pendingBackup;
    if (!draft)
        return openBackupDialog();
    state.backupSaving = true;
    updateBackupFormValidity();
    button.disabled = true;
    button.textContent = "Encrypting…";
    $("#backup-confirm-back").disabled = true;
    if (draft.repositoryUrl)
        setBackupConfirmationStep("code", "running", "Queued");
    setBackupConfirmationStep("collect", "running", "Working");
    setBackupConfirmationStep("encrypt", "running", "Queued");
    try {
        await api("/api/backup/settings", { method: "POST", timeout: 0, body: draft });
        if (!backupAccessCurrent(epoch))
            return;
        const confirmation = await api("/api/backup/confirmation", { method: "POST", body: draft });
        if (!backupAccessCurrent(epoch))
            return;
        state.pendingBackup.confirmationId = confirmation.confirmationId;
        setBackupConfirmationStep("collect", "complete", "Done");
        setBackupConfirmationStep("encrypt", "running", "Working");
        const job = await api("/api/backup/sync", { method: "POST", body: { confirmationId: draft.confirmationId } });
        if (!backupAccessCurrent(epoch))
            return;
        state.backgroundJobs = [job, ...state.backgroundJobs.filter((item) => item.id !== job.id)];
        state.backgroundJobStatuses.set(job.id, job.status);
        state.dismissedBackgroundJobs.delete(job.id);
        state.backgroundJobsMinimized = false;
        renderBackgroundJobs();
        state.backupDraftRepositoryUrl = null;
        state.backupDraftDriveDirectory = null;
        $("#backup-passphrase").value = "";
        state.pendingBackup = null;
        $("#backup-confirm-dialog").close();
        toast("Backup started in the background. Argus remains available while it completes.");
    }
    catch (error) {
        if (!backupAccessCurrent(epoch, error))
            return;
        const resultBox = $("#backup-confirm-result");
        resultBox.classList.remove("hidden", "warning", "success");
        resultBox.classList.add("error");
        resultBox.innerHTML = `<strong>Backup stopped.</strong><span>${escapeHtml(error.message)}</span>`;
        $$('[data-backup-step].running').forEach((step) => { step.classList.replace("running", "failed"); step.querySelector("em").textContent = "Failed"; });
    }
    finally {
        state.backupSaving = false;
        button.disabled = false;
        button.textContent = "Encrypt & save";
        $("#backup-confirm-back").disabled = false;
        updateBackupFormValidity();
    }
}
async function restoreArgusBackup() {
    if (!backupAccessCurrent())
        return;
    if (backupSettingsUnresolved())
        return;
    if (backupOperationActive())
        return toast("Wait for the current operation before restoring a backup.", "error");
    const epoch = state.backupAccessEpoch;
    if (!confirm("Restore the latest encrypted Argus backup? Stop active work first. Current local data will be replaced and Argus must restart. Recovery copies are retained if a rollback cannot finish."))
        return;
    state.backupRestoring = true;
    updateBackupFormValidity();
    const button = $("#restore-argus-backup");
    button.disabled = true;
    button.textContent = "Restoring…";
    try {
        await api("/api/backup/restore", { method: "POST", timeout: 0, body: { passphrase: $("#backup-passphrase").value } });
        if (!backupAccessCurrent(epoch))
            return;
        toast("Argus data restored. Restarting the desktop app…");
        if (window.argusDesktop?.restartAfterMaintenance)
            await window.argusDesktop.restartAfterMaintenance();
        else
            toast("Restore completed. Quit and reopen Argus before continuing.");
    }
    catch (error) {
        if (backupAccessCurrent(epoch, error))
            toast(error.message, "error");
    }
    finally {
        state.backupRestoring = false;
        button.textContent = "Restore latest backup";
        updateBackupFormValidity();
    }
}
const DATA_STORAGE_CATEGORIES = [
    { id: "workspace", icon: "⌘", title: "Workspace & project settings", summary: "Connected repository paths, active tab, UI preferences, run configurations, and detected project settings.", protection: "Private file · mode 0600", backup: "Included in encrypted backup", detail: "Saved as readable JSON so Argus can recover the workspace after restart. Environment secret values and AI account credentials are not written here.", openTarget: "data" },
    { id: "environments", icon: "ENV", title: "Service environments", summary: "The latest complete .env snapshot for each run configuration, including values imported from Vault JSON.", protection: "Private files · mode 0600", backup: "Included in encrypted backup", detail: "Snapshots are plain-text local files protected by macOS file permissions; they are not separately encrypted at rest by Argus. Selected secret bundles also live in macOS Keychain.", openTarget: "data", sensitive: true },
    { id: "aiTasks", icon: "AI", title: "AI tasks & transcripts", summary: "Prompts, direct CLI responses, task metadata, and readable Markdown transcripts.", protection: "Private local files", backup: "Included in encrypted backup", detail: "Fresh requests do not retrieve earlier chats. When previous chat context is selected, Argus can use bounded task history plus matching concise summaries. CLI credentials are never copied into these records.", openTarget: "data", sensitive: true },
    { id: "attachments", icon: "＋", title: "Context attachments", summary: "Large prompt pastes and browser-tab captures explicitly attached to a task.", protection: "Private files · mode 0600", backup: "Included in encrypted backup", detail: "Each attachment can be up to 20 MB. The index exposes the newest 100 entries; attachment files remain local until the user removes Argus data or restores another backup.", openTarget: "data", sensitive: true },
    { id: "repositoryArtifacts", icon: "KIT", title: "Repository AI kits", summary: "Private AGENTS.md routing, skill-coverage.json, and business-flow Skills generated by a connected coding CLI.", protection: "Private local files", backup: "Included in encrypted backup", detail: "Each refresh reads an isolated production-branch snapshot. The previous kit remains in place if generation or validation fails. Offboarding disconnects the repository and keeps its private kit and saved data.", openTarget: "data" },
    { id: "apiCollections", icon: "{}", title: "API collections & environments", summary: "Postman-compatible collections, request definitions, generated cURL files, and API environment values.", protection: "Local files · inspectable", backup: "Included in encrypted backup", detail: "Saved request headers or environment values can contain tokens. These files are not encrypted at rest by Argus, so treat this folder as sensitive and avoid committing it to another repository.", openTarget: "apiCollections", sensitive: true },
    { id: "uiPreferences", icon: "UI", title: "Interface preferences", summary: "Theme, font size, panel sizes, collapsed collection folders, and the selected API environment ID.", protection: "Electron local storage", backup: "Not included in backup", detail: "These records customize layout only and are stored inside Electron’s Chromium profile. Argus does not intentionally place credentials or request bodies here.", openTarget: "data" },
        { id: "keychain", icon: "◇", title: "macOS Keychain secrets", summary: "Recovery passphrase, environment secret bundles, and the server-side Chrome pairing token.", protection: "Encrypted by macOS Keychain", backup: "Environment bundles only", detail: "The recovery passphrase and browser-pairing token never enter the encrypted archive. CLI credentials stay with their CLIs.", pathLabel: "macOS Login Keychain · argus-personal: and com.argus.personal namespaces" },
    { id: "backupRepository", icon: "⇧", title: "Encrypted backup working copy", summary: "A dedicated Git checkout containing readable Argus source plus the encrypted private-data archive and manifest.", protection: "Private data encrypted before upload", backup: "Git remote first · then Drive mirror", detail: "Argus uses AES-256-GCM with a scrypt-derived key. After a successful Git remote push, Drive receives the matching readable source and encrypted private-data snapshot. If the push fails, the previous Drive snapshot stays untouched. The recovery passphrase is never copied.", openTarget: "backupRepository", sensitive: true },
];
function renderDataStorageCard(category, inventory) {
    const pathValue = category.id === "keychain" ? "" : inventory.locations?.[category.id] || "";
    const available = category.id === "keychain" || Boolean(inventory.availability?.[category.id]);
    const pathLabel = category.pathLabel || pathValue || "Created when this feature is first used";
    const extra = category.id === "backupRepository"
        ? `<div class="storage-detail-row"><span>Git remote</span><code>${escapeHtml(inventory.backup?.repositoryUrl || "Not configured")}</code></div><div class="storage-detail-row"><span>Google Drive</span><code>${escapeHtml(inventory.backup?.googleDriveDirectory || "Not configured")}</code></div>`
        : "";
    const bytes = Number(inventory.diskUsage?.sizes?.[category.id] || 0);
    return `<details data-storage-category="${category.id}" class="storage-card ${category.sensitive ? "is-sensitive" : ""}">
    <summary class="storage-card-heading"><span class="storage-card-icon">${escapeHtml(category.icon)}</span><span class="storage-card-copy"><strong>${escapeHtml(category.title)}</strong><small>${escapeHtml(category.summary)}</small></span><span class="storage-card-state ${available ? "available" : ""}">${available ? formatBytes(bytes) : "On first use"}</span><svg class="storage-card-chevron disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"></path></svg></summary>
    <div class="storage-card-detail"><div class="storage-path-row"><code title="${escapeHtml(pathLabel)}">${escapeHtml(pathLabel)}</code><div>${pathValue ? `<button type="button" data-copy-storage-path="${escapeHtml(pathValue)}">Copy path</button>` : ""}${category.openTarget ? `<button type="button" data-open-storage="${escapeHtml(category.openTarget)}" ${available ? "" : "disabled"}>Open in Finder</button>` : ""}</div></div>
      <div class="storage-badges"><span>${escapeHtml(category.protection)}</span><span>${escapeHtml(category.backup)}</span></div><p>${escapeHtml(category.detail)}</p>${extra}</div>
  </details>`;
}
function renderDataStorage(inventory) {
    $("#data-storage-root").textContent = inventory.dataDirectory;
    $("#data-storage-total").textContent = formatBytes(Number(inventory.diskUsage?.totalBytes || 0));
    $("#data-storage-list").innerHTML = DATA_STORAGE_CATEGORIES.filter((category) => category.id !== "backupRepository" || backupAccessCurrent()).map((category) => renderDataStorageCard(category, inventory)).join("");
    $("#storage-repository-count").textContent = String(inventory.repositories?.length || 0);
    $("#storage-repository-list").innerHTML = (inventory.repositories || []).length
        ? inventory.repositories.map((repository) => `<div><strong>${escapeHtml(repository.name)}</strong><code>${escapeHtml(repository.path)}</code><button type="button" data-copy-storage-path="${escapeHtml(repository.path)}">Copy</button></div>`).join("")
        : '<p class="storage-empty">No source repositories are connected.</p>';
}
let storageLoadController;
async function selectLocalDataTab(tab) {
    $("#local-storage-panel").hidden = false;
    storageLoadController?.abort();
    const controller = new AbortController();
    storageLoadController = controller;
    $("#data-storage-root").textContent = "Loading local paths…";
    $("#data-storage-list").innerHTML = '<div class="storage-loading">Reading Argus storage locations…</div>';
    try {
        const inventory = await api("/api/data-storage", { signal: controller.signal, dedupe: false });
        if (!controller.signal.aborted && $("#data-storage-dialog").open)
            renderDataStorage(inventory);
    }
    catch (error) {
        if (!controller.signal.aborted)
            $("#data-storage-list").innerHTML = `<div class="storage-loading storage-error">${escapeHtml(error.message)}</div>`;
    }
}
function openDataStorageDialog() {
    showAppDialog("data-storage-dialog");
    if ($("#data-storage-dialog").open)
        void selectLocalDataTab("storage");
}
async function handleDataStorageAction(event) {
    const reset = event.target.closest("#reset-all-argus-data");
    if (reset) {
        if (!window.argusDesktop?.resetAllData)
            return toast("A full reset is available in the desktop app", "error");
        const confirmation = prompt('This permanently erases all Argus data and configured Argus backups, then restarts empty. Your source repositories and coding-CLI login are not touched.\n\nType "delete all argus data" to continue:');
        if (confirmation == null)
            return;
        reset.disabled = true;
        reset.textContent = "Erasing & restarting…";
        try {
            await window.argusDesktop.resetAllData(confirmation);
        }
        catch (error) {
            reset.disabled = false;
            reset.textContent = "Erase all & start fresh";
            toast(error.message, "error");
        }
        return;
    }
    const copy = event.target.closest("[data-copy-storage-path]");
    if (copy) {
        try {
            await navigator.clipboard.writeText(copy.dataset.copyStoragePath);
            copy.textContent = "Copied";
            setTimeout(() => { copy.textContent = copy.closest("#storage-repository-list") ? "Copy" : "Copy path"; }, 1200);
        }
        catch {
            toast("Could not copy this path", "error");
        }
        return;
    }
    const open = event.target.closest("[data-open-storage]");
    if (!open)
        return;
    const ownerBackupFolder = open.dataset.openStorage === "backupRepository";
    if (ownerBackupFolder && !backupAccessCurrent())
        return;
    const epoch = state.backupAccessEpoch;
    open.disabled = true;
    try {
        await api("/api/data-storage/open", { method: "POST", body: { target: open.dataset.openStorage } });
    }
    catch (error) {
        if (!ownerBackupFolder || backupAccessCurrent(epoch, error))
            toast(error.message, "error");
    }
    finally {
        open.disabled = ownerBackupFolder && !backupAccessCurrent();
    }
}
function setRefreshLoading(button, loading) {
    if (!button)
        return;
    button.disabled = loading;
    button.classList.toggle("loading", loading);
    const glyph = button.querySelector(".refresh-glyph");
    glyph?.classList.toggle("loading", loading);
    button.setAttribute("aria-busy", String(loading));
}
function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
function formatMessageTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return "";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
function formatExecutionTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return "";
    return new Intl.DateTimeFormat(undefined, {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(date);
}
function scopedAttachments(scope) {
    if (scope === "global")
        return state.globalAttachments;
    const repositoryId = state.activeRepository?.id;
    if (!repositoryId)
        return [];
    return state.repositoryAttachments[repositoryId] ||= [];
}
function selectedProvider(scope) {
    const control = scope === "global" ? $("#global-agent-provider") : $("#agent-provider");
    return state.providers.find((item) => item.id === control?.value);
}
function normalizedContextKind(kind) {
    return kind === "paste" ? "file" : kind;
}
function providerSupportsContext(provider, kind) {
    return Boolean(provider?.contextCapabilities?.includes(normalizedContextKind(kind)));
}
function compatibleContextProvider(kind) {
    return state.providers.find((provider) => providerCanRun(provider) && providerSupportsContext(provider, kind));
}
function showUnsupportedContext(scope, kind) {
    const provider = selectedProvider(scope);
    const compatible = compatibleContextProvider(kind);
    const contextName = kind === "browser" ? "browser-tab context" : kind === "image" ? "images" : "large pasted files";
    state.unsupportedContextRequest = { scope, kind, providerId: compatible?.id || "" };
    $("#unsupported-context-summary").textContent = `${provider?.name || "The selected provider"} does not currently support ${contextName} through Argus.`;
    $("#unsupported-context-provider").textContent = compatible ? `Switch to ${compatible.name}` : "No compatible provider is currently ready";
    $("#unsupported-context-detail").textContent = compatible
        ? `${compatible.name} can receive this context. Your text draft will remain unchanged when you switch.`
        : "Connect and verify a coding-agent CLI with this capability, then try attaching the context again.";
    $("#switch-context-provider").classList.toggle("hidden", !compatible);
    showAppDialog("unsupported-context-dialog");
    return false;
}
function validateComposerContext(scope, attachments = scopedAttachments(scope)) {
    const unsupported = attachments.find((item) => !providerSupportsContext(selectedProvider(scope), item.kind));
    return unsupported ? showUnsupportedContext(scope, unsupported.kind) : true;
}
function updateProviderContextControls(scope) {
    const provider = selectedProvider(scope);
    const button = document.querySelector(`[data-attach-browser="${scope}"]`);
    const fileButton = document.querySelector(`[data-attach-file="${scope}"]`);
    if (!button || !fileButton)
        return;
    const supported = providerSupportsContext(provider, "browser");
    button.classList.toggle("context-unsupported", !supported);
    button.title = supported
        ? "Attach the latest tab shared by the Argus Chrome extension"
        : `${provider?.name || "This provider"} cannot receive browser context. Click for details.`;
    const fileSupported = providerSupportsContext(provider, "file");
    fileButton.classList.toggle("context-unsupported", !fileSupported);
    fileButton.title = fileSupported
        ? "Attach files from this Mac"
        : `${provider?.name || "This provider"} cannot receive file attachments. Click for details.`;
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function renderProductionBranchSelection() {
    const host = $("#repo-production-branches");
    const repositories = state.pendingOnboardingRepositories;
    host.classList.toggle("hidden", !repositories.length);
    host.innerHTML = repositories.length ? `<header><strong>Choose repositories & production branches</strong><small>Existing choices are preserved. New repositories default to main, then master. Uncheck any repository to skip it.</small></header>${repositories.map((repository, index) => {
        const blocked = repository.eligible === false || Boolean(repository.error) || !(repository.branches || []).length;
        return `<div class="repo-production-branch-row ${repository.onboarding || blocked ? "already-onboarding" : ""}"><label class="repo-selection-label"><input type="checkbox" data-onboarding-include="${index}" aria-label="Include ${escapeHtml(repository.name)}" ${blocked || repository.onboarding ? "disabled" : repository.excluded ? "" : "checked"} /><strong title="${escapeHtml(repository.path)}">${escapeHtml(repository.name)}</strong></label>${repository.onboarding ? '<span>Already onboarding</span>' : blocked ? `<span class="repo-discovery-error">${escapeHtml(repository.error || "No committed branch yet. Create the first commit in Git, then choose this folder again.")}</span>` : `<select data-production-branch-index="${index}" aria-label="Production branch for ${escapeHtml(repository.name)}" ${repository.excluded ? "disabled" : ""}><option value="">Select production branch…</option>${repository.branches.map((branch) => `<option value="${escapeHtml(branch)}" ${branch === repository.productionBranch ? "selected" : ""}>${escapeHtml(branch)}</option>`).join("")}</select>`}</div>`;
    }).join("")}` : "";
    const eligible = selectedOnboardingRepositories();
    $("#confirm-repo").disabled = Boolean(state.folderDiscoveryBusy || state.onboardingSubmitting || state.repositoryCloneBusy || state.cloneDestinationChoosing)
        || !eligible.length || eligible.some((repository) => !repository.productionBranch);
}
function selectedOnboardingRepositories() {
    return state.pendingOnboardingRepositories.filter(repository => !repository.onboarding && !repository.excluded
        && repository.eligible !== false && !repository.error && repository.branches?.length);
}
async function refreshCloneHistory() {
    const revision = state.cloneHistoryRevision = (state.cloneHistoryRevision || 0) + 1;
    const host = $("#clone-job-history");
    try {
        const jobs = await repositoryCloneJobs.list();
        if (revision !== state.cloneHistoryRevision)
            return;
        state.cloneJobHistory = jobs;
        const active = job => ["queued", "running", "cancelling"].includes(job.status);
        const visible = [...jobs.filter(active), ...jobs.filter(job => !active(job) && (job.status !== "completed" || !state.workspace?.repositories?.some(repo => repo.path === job.result?.repository?.path))).slice(0, 8)];
        host.classList.toggle("hidden", !visible.length);
        host.innerHTML = visible.length ? `<strong>Recent clones</strong>${visible.map(job => `<div><span><b>${escapeHtml(job.result?.repository?.name || job.targetPath?.split("/").pop() || "Repository")}</b><small>${escapeHtml(job.status)}${job.error ? ` · ${escapeHtml(job.error)}` : ""}</small></span>${["queued", "running", "cancelling", "completed"].includes(job.status) ? `<button type="button" data-resume-clone="${escapeHtml(job.id)}" ${state.repositoryCloneBusy ? "disabled" : ""}>${job.status === "completed" ? "Continue onboarding" : "Resume status"}</button>` : ""}</div>`).join("")}` : "";
    }
    catch {
        if (revision === state.cloneHistoryRevision) {
            host.classList.remove("hidden");
            host.textContent = "Recent clones could not be loaded. Reopen this panel to retry. Completed clones can also be added using On this Mac.";
        }
    }
}
async function refreshOnboardingPrerequisites() {
    const button = $("#onboarding-prerequisites-refresh");
    if (button.disabled)
        return;
    button.disabled = true;
    const status = $("#onboarding-prerequisites-status");
    status.textContent = "Checking Git availability…";
    try {
        const result = await api("/api/repository-onboarding/prerequisites", { dedupe: false });
        status.textContent = result.message || (result.available ? `Git ${result.version || "available"}` : "Git is unavailable. Install Git and restart Argus.");
        if (result.compatible === false)
            $("#repo-dialog .repo-prerequisites").open = true;
    }
    catch {
        status.textContent = "Could not check Git. Verify git --version in Terminal, then retry.";
    }
    finally {
        button.disabled = false;
    }
}
function renderContextTray(scope) {
    const tray = scope === "global" ? $("#global-context-tray") : $("#agent-context-tray");
    const attachments = scopedAttachments(scope);
    const recoveries = composerRecoveries(scope);
    tray.classList.toggle("has-context", attachments.length > 0 || recoveries.length > 0);
    tray.querySelector(".context-chips").innerHTML = attachments.map(item => attachmentCardMarkup(item, { scope, removable: true })).join("");
    for (const recovery of recoveries) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "context-chip";
        button.textContent = recovery.cancelled ? "Restore stopped request" : "Restore unsent request";
        button.title = recovery.draft || recovery.attachments?.map(item => item.title).join(", ") || "Unsent attachments";
        button.addEventListener("click", () => {
            recoveries.splice(recoveries.indexOf(recovery), 1);
            const current = takeComposerDraft(scope);
            if (current.draft || current.attachments.length)
                keepComposerRecovery(current);
            if (restoreComposerDraft(recovery)) {
                recovery.epoch = state.composerDraftEpochs[recovery.key] || 0;
                recovery.attachments = [];
                recovery.draft = "";
            }
        });
        tray.querySelector(".context-chips").append(button);
    }
}
function renderMessageAttachments(attachments = []) {
    if (!attachments.length)
        return "";
    return `<div class="chat-message-attachments">${attachments.map(item => attachmentCardMarkup(item)).join("")}</div>`;
}
function insertTextAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(textarea.selectionEnd)}`;
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
}
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
}
async function attachPastedImages(event, scope) {
    const textarea = event.currentTarget;
    const images = [...(event.clipboardData?.items || [])]
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);
    if (!images.length)
        return false;
    event.preventDefault();
    if (!providerSupportsContext(selectedProvider(scope), "image")) {
        showUnsupportedContext(scope, "image");
        return true;
    }
    const context = captureComposerUpload(scope);
    const supported = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    try {
        for (const [index, image] of images.entries()) {
            if (!supported.has(image.type))
                throw new Error("Paste a PNG, JPEG, GIF, or WebP image.");
            if (image.size > 20000000)
                throw new Error("Image is larger than 20 MB. Paste a smaller file.");
            const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image.type];
            const title = image.name && image.name !== "image.png" ? image.name : `Pasted image ${images.length > 1 ? `${index + 1} ` : ""}· ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${extension}`;
            const attachment = await api("/api/context", { method: "POST", body: { kind: "image", title, contentBase64: arrayBufferToBase64(await image.arrayBuffer()), mimeType: image.type, repositoryId: context.repositoryId } });
            finishComposerAttachment(context, attachment, images.length === 1 ? "Please analyze the attached image." : "Please analyze the attached images.");
        }
    }
    finally {
        state.composerUploads.delete(context);
    }
    toast(`${images.length} image${images.length === 1 ? "" : "s"} attached`);
    return true;
}
async function attachSelectedFiles(fileList, scope) {
    const files = [...(fileList || [])];
    if (!files.length)
        return;
    if (!providerSupportsContext(selectedProvider(scope), "file"))
        return showUnsupportedContext(scope, "file");
    const attachments = scopedAttachments(scope);
    if (attachments.length + files.length > 10)
        throw new Error("Attach at most 10 items to one prompt.");
    const context = captureComposerUpload(scope);
    try {
        for (const file of files) {
            if (file.size > 20000000)
                throw new Error(`${file.name} is larger than 20 MB. Choose a smaller file.`);
            const attachment = await api("/api/context", {
                method: "POST",
                body: {
                    kind: "file",
                    title: file.name || "Attached file",
                    contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
                    mimeType: file.type || "application/octet-stream",
                    repositoryId: context.repositoryId,
                },
            });
            finishComposerAttachment(context, attachment);
        }
    }
    finally {
        state.composerUploads.delete(context);
    }
    toast(`${files.length} file${files.length === 1 ? "" : "s"} attached`);
}
async function handleComposerPaste(event, scope) {
    const textarea = event.currentTarget;
    const text = event.clipboardData?.getData("text/plain") || "";
    if ([...(event.clipboardData?.items || [])].some(item => item.kind === "file" && item.type.startsWith("image/"))) {
        try {
            await attachPastedImages(event, scope);
        }
        catch (error) {
            toast(error?.message, "error");
        }
        return;
    }
    if (text.length < 4000)
        return;
    event.preventDefault();
    if (!providerSupportsContext(selectedProvider(scope), "file")) {
        showUnsupportedContext(scope, "file");
        return;
    }
    const context = captureComposerUpload(scope);
    const originalDraft = textarea.value;
    try {
        const attachment = await api("/api/context", { method: "POST", body: { kind: "paste", title: `Pasted context · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, content: text, repositoryId: context.repositoryId } });
        finishComposerAttachment(context, attachment, "Please analyze the attached context.");
        toast(`Long paste saved as a local ${formatBytes(attachment.size)} attachment`);
    }
    catch (error) {
        if (composerContextIsCurrent(context) && (state.composerDraftEpochs?.[context.key] || 0) === context.epoch && textarea.value === originalDraft) {
            insertTextAtCursor(textarea, text);
            storeComposerDraft(scope);
            resizeAgentComposer(textarea);
        }
        else
            keepComposerRecovery({ ...context, draft: text, attachments: [] });
        toast(error.message, "error");
    }
    finally {
        state.composerUploads.delete(context);
    }
}
async function attachLatestBrowserContext(scope) {
    if (!providerSupportsContext(selectedProvider(scope), "browser"))
        return showUnsupportedContext(scope, "browser");
    const context = captureComposerUpload(scope);
    try {
        const attachment = await api("/api/browser-context/latest");
        if (!attachment)
            return toast("No Chrome tab has been shared yet. Use the Argus extension on the tab first.", "error");
        finishComposerAttachment(context, attachment);
        toast(`Attached Chrome tab: ${attachment.title}`);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        state.composerUploads.delete(context);
    }
}
function relativeTime(value) {
    const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60)
        return "just now";
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}
function activeTaskId(scope) {
    return scope === "global" ? state.activeGlobalTaskId : state.activeTaskByRepository[state.activeRepository?.id];
}
const taskPromptNotes = createTaskPromptNotes({
    document, storage: localStorage,
    getContext: (scope) => ({ scope, repositoryId: scope === "global" ? "global" : state.activeRepository?.id, taskId: activeTaskId(scope) || null }),
    loadTask: (taskId) => api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" }),
    saveTask: (context, promptNotes) => api(`/api/ai-tasks/${encodeURIComponent(context.taskId)}/prompt-notes`, { method: "PUT", body: { promptNotes, scope: context.scope, repositoryId: context.repositoryId } }),
    beforeOpen: closeOpenDialogs,
    onError: (error) => toast(error.message, "error"),
});
function queuedPrompts(scope, taskId = activeTaskId(scope)) {
    if (!taskId)
        return [];
    const queues = scope === "global" ? state.globalPromptQueues : state.repositoryPromptQueues;
    return queues[taskId] ||= [];
}
function taskList(scope) {
    return scope === "global" ? state.globalTasks : (state.repositoryTasks[state.activeRepository?.id] || []);
}
function renderTaskList(scope, options = {}) {
    const target = scope === "global" ? $("#global-task-list") : $("#repository-task-list");
    if (!options.force && target.querySelector(".task-row.is-renaming"))
        return;
    const activeId = activeTaskId(scope);
    const tasks = taskList(scope);
    target.innerHTML = tasks.length ? tasks.map((task) => {
        const title = String(task.title || "New task");
        const visibleTitle = [...title].slice(0, 20).join("");
        return `<div class="task-row ${task.id === activeId ? "active" : ""}" data-task-scope="${scope}" title="${escapeHtml(title)}"><button class="task-row-main" data-ai-task="${task.id}"><strong>${escapeHtml(visibleTitle)}</strong><small>${task.messageCount || 0} messages · ${relativeTime(task.updatedAt)}</small></button><div class="task-row-actions"><button data-rename-task="${task.id}" title="Rename task">✎</button><button data-delete-task="${task.id}" title="Delete task">×</button></div></div>`;
    }).join("") : `<div class="task-empty">No saved tasks yet.<br />Click ＋ to begin.</div>`;
}
async function refreshTasks(scope, selectLatest = false, { isCurrent = () => true, preserveSelection = false } = {}) {
    const repositoryId = scope === "global" ? "global" : state.activeRepository?.id;
    if (!repositoryId)
        return;
    const tasks = await api(`/api/ai-tasks?scope=${scope}&repositoryId=${encodeURIComponent(repositoryId)}`);
    if (!isCurrent())
        return;
    if (scope === "global") {
        state.globalTasks = tasks;
        const preparingDraft = state.globalSubmitting && state.globalSubmission && !state.globalSubmission.taskId && !state.activeGlobalTaskId;
        if (!preserveSelection && !preparingDraft && (selectLatest || !tasks.some((task) => task.id === state.activeGlobalTaskId)))
            state.activeGlobalTaskId = tasks[0]?.id || null;
    }
    else {
        state.repositoryTasks[repositoryId] = tasks;
        const preparingDraft = state.repositorySubmitting[repositoryId] && state.repositorySubmissions[repositoryId] && !state.repositorySubmissions[repositoryId].taskId && !state.activeTaskByRepository[repositoryId];
        if (!preserveSelection && !preparingDraft && (selectLatest || !tasks.some((task) => task.id === state.activeTaskByRepository[repositoryId])))
            state.activeTaskByRepository[repositoryId] = tasks[0]?.id || null;
    }
    renderTaskList(scope);
}
function startTaskDraft(scope) {
    const repositoryId = scope === "global" ? "global" : state.activeRepository?.id;
    if (!repositoryId)
        return;
    if (composerIsSubmitting(scope))
        return toast("Wait for the current request to start before opening a new task.");
    if (scope === "global")
        state.activeGlobalTaskId = null;
    else
        state.activeTaskByRepository[repositoryId] = null;
    taskPromptNotes.resetDraft(scope);
    if (scope === "global")
        modelSelections.delete(modelSelectionKey(scope, null, null));
    const draftKey = currentModelSelectionKey(scope);
    chatContextPreference.reset(draftKey);
    modelDraftEpochs.set(draftKey, (modelDraftEpochs.get(draftKey) || 0) + 1);
    renderModelControls(scope);
    renderTaskList(scope);
    if (scope === "repository") {
        repositoryTaskDrawer?.dismiss();
        if (document.body.classList.contains("repository-ide-chat-hidden"))
            repositoryIdeBridge.setChatVisible(true);
    }
    const prompt = scope === "global" ? $("#global-agent-prompt") : $("#agent-prompt");
    prompt.value = "";
    storeComposerDraft(scope, "");
    resizeAgentComposer(prompt);
    renderContextTray(scope);
    prompt.focus();
    const output = scope === "global" ? $("#global-agent-output-card") : $("#agent-output-card");
    output.classList.add("hidden");
    setComposerActionState(scope, false);
    renderTaskConversation(scope, { messages: [] });
    const contextControl = scope === "global" ? $("#global-agent-context-mode") : $("#agent-context-mode");
    if (contextControl)
        contextControl.value = "history";
    renderContextMode(scope);
    syncViewUrl(scope === "global" ? "global" : "repository");
    toast("New task draft ready. It will be saved after your first prompt.");
}
function renameTask(scope, taskId) {
    const task = taskList(scope).find((item) => item.id === taskId);
    const list = scope === "global" ? $("#global-task-list") : $("#repository-task-list");
    const button = [...list.querySelectorAll("[data-rename-task]")].find((item) => item.dataset.renameTask === taskId);
    const row = button?.closest(".task-row");
    const main = row?.querySelector(".task-row-main");
    if (!task || !row || !main || row.classList.contains("is-renaming"))
        return;
    row.classList.add("is-renaming");
    const editor = document.createElement("div");
    editor.className = "task-row-editor";
    const input = document.createElement("input");
    input.className = "task-title-input";
    input.value = task.title;
    input.maxLength = 20;
    input.setAttribute("aria-label", "Task name");
    input.spellcheck = false;
    const metadata = main.querySelector("small")?.cloneNode(true);
    editor.append(input);
    if (metadata)
        editor.append(metadata);
    main.replaceWith(editor);
    input.focus();
    input.select();
    let finished = false;
    const finish = async (save) => {
        if (finished)
            return;
        finished = true;
        const title = input.value.replace(/\s+/g, " ").trim();
        if (!save || !title || title === task.title) {
            row.classList.remove("is-renaming");
            renderTaskList(scope, { force: true });
            return;
        }
        input.disabled = true;
        row.classList.add("is-saving");
        try {
            await api(`/api/ai-tasks/${taskId}`, { method: "PATCH", body: { title } });
            row.classList.remove("is-renaming");
            await refreshTasks(scope);
            toast("Task renamed");
        }
        catch (error) {
            row.classList.remove("is-renaming");
            renderTaskList(scope, { force: true });
            toast(error.message, "error");
        }
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
        }
        else if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
        }
    });
    input.addEventListener("blur", () => finish(true));
}
async function deleteTask(scope, taskId) {
    const task = taskList(scope).find((item) => item.id === taskId);
    if (!confirm(`Delete “${task?.title || "this task"}” and its local transcript?`))
        return;
    try {
        await api(`/api/ai-tasks/${taskId}`, { method: "DELETE" });
        modelSelections.delete(modelSelectionKey(scope, null, taskId));
        const queues = scope === "global" ? state.globalPromptQueues : state.repositoryPromptQueues;
        delete queues[taskId];
        if (scope === "global" && state.activeGlobalTaskId === taskId)
            state.activeGlobalTaskId = null;
        if (scope === "repository" && state.activeTaskByRepository[state.activeRepository.id] === taskId)
            state.activeTaskByRepository[state.activeRepository.id] = null;
        await refreshTasks(scope);
        const next = activeTaskId(scope);
        if (next)
            await selectTask(scope, next);
        else
            startTaskDraft(scope);
        toast("Task deleted from this Mac");
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function emptyConversationMarkup(scope) {
    return scope === "global"
        ? `<div class="chat-empty-state"><p class="eyebrow">ALL CONNECTED REPOSITORIES</p><h1>What are we shipping?</h1><p>Trace a flow, investigate an incident, or coordinate a change across connected services.</p></div>`
        : `<div class="chat-empty-state"><p class="eyebrow">ACTIVE REPOSITORY ONLY</p><h1>What are we shipping?</h1><p>Describe the outcome in plain English. Your agent can inspect, edit and test this repository while every modification stays visible in Git.</p></div>`;
}
const coordinatePromptRevision = createPromptRevisionCoordinator({
    api,
    isCurrent: (scope, task) => activeTaskId(scope) === task.id && (scope === "global" || state.activeRepository?.id === task.repositoryId),
    hasQueuedWork: (scope, taskId) => Boolean(queuedPrompts(scope, taskId).length || state.promptQueueSaves.has(taskId) || state.promptQueueProcessors.has(`${scope}:${taskId}`)),
    getSubmission: (scope, repositoryId) => scope === "global" ? state.globalSubmission : state.repositorySubmissions[repositoryId],
});
const chooseRevisionScope = createRevisionScopePicker({ document });
const revisionComposerChecks = new Set();
const revisionComposerRetries = new Map();
const revisionFlows = new Map();
function promptRevisionFlow(scope) {
    if (revisionFlows.has(scope))
        return revisionFlows.get(scope);
    const flow = createPromptRevisionFlow({ api: (...args) => api(...args), coordinate: coordinatePromptRevision,
        createRequestId: () => crypto.randomUUID(),
        isCurrent: task => activeTaskId(scope) === task.id && (scope === "global" || state.activeRepository?.id === task.repositoryId),
        validate: task => {
            if (queuedPrompts(scope, task.id).length)
                throw new Error("Wait for this chat’s queued prompts to finish before editing an earlier request.");
            const provider = state.providers.find(item => item.id === task.provider);
            if (!provider?.authenticated)
                throw new Error(`${provider?.name || "The chat’s AI provider"} sign-in is required.`);
            if (!providerCanRun(provider))
                throw new Error(providerBlockedMessage(provider));
        },
        chooseScope: async (task) => {
            if (scope !== "global")
                return {};
            const workspace = await loadWorkspaceSnapshot();
            const repositories = workspace.repositories || [];
            if (task.repositoryIds?.length && !task.repositoryIds.some(id => !repositories.some(repo => repo.id === id)))
                return {};
            return chooseRevisionScope({ task, repositories, disconnectedRepositories: workspace.disconnectedRepositories || [] });
        },
        accept: task => acceptPromptRevision(scope, task),
        dispatch: request => startQueuedPrompt(scope, request),
        present: async (result) => {
            const revised = result.task;
            const visible = () => activeTaskId(scope) === revised.id && (scope === "global" || state.activeRepository?.id === revised.repositoryId);
            if (visible()) {
                try {
                    await refreshTasks(scope, false, { preserveSelection: true, isCurrent: visible });
                    if (visible())
                        await selectTask(scope, revised.id);
                }
                catch (error) {
                    toast(`Edit saved in this chat. Reload the chat to see it. ${error.message}`, "error");
                    return;
                }
            }
            if (result.error) {
                const rejected = result.error.status >= 400 && result.error.status < 500;
                toast(`Edit saved in this chat; ${rejected ? "response was not started" : "submission could not be confirmed"}: ${result.error.message}. Your draft is kept.`, "error");
            }
            else
                toast(result.alreadySubmitted ? "This edit was already saved · showing the current chat" : "Edited request submitted in the original chat · previous version kept");
        },
    });
    revisionFlows.set(scope, flow);
    return flow;
}
function revisionIsBusy(scope, taskId = activeTaskId(scope)) {
    return revisionComposerChecks.has(taskId) || Boolean(revisionFlows.get(scope)?.isBusy(taskId));
}
async function submitPromptRevision(input) {
    return promptRevisionFlow(input.scope).submit(input);
}
async function retryRevisionFromComposer(scope) {
    const taskId = activeTaskId(scope);
    if (!taskId)
        return false;
    if (revisionIsBusy(scope, taskId))
        return true;
    const repositoryId = composerRepositoryId(scope);
    const textarea = $(scope === "global" ? "#global-agent-prompt" : "#agent-prompt");
    const draft = textarea.value;
    if (!draft.trim())
        return false;
    revisionComposerChecks.add(taskId);
    let captured;
    try {
        let task = await api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" });
        if (activeTaskId(scope) !== taskId || composerRepositoryId(scope) !== repositoryId || textarea.value !== draft)
            return true;
        if (!task.revisionDraft) {
            const pending = revisionComposerRetries.get(taskId);
            if (!pending)
                return false;
            if (task.revisionOf?.runRequestId !== pending.revisionDraft?.runRequestId || task.revisionCount !== pending.revisionCount) {
                revisionComposerRetries.delete(taskId);
                throw new Error("This chat changed after the earlier submission. Your text is kept; review the current chat, then send again if this is a new message.");
            }
            if (task.revisionOf?.runRequestId === pending.revisionDraft?.runRequestId && task.revisionCount === pending.revisionCount
                && draft.trim() !== pending.revisionDraft.prompt) {
                revisionComposerRetries.delete(taskId);
                return false;
            }
            task = pending;
        }
        const saved = task.revisionDraft;
        if ($(scope === "global" ? "#global-task-notes" : "#repository-task-notes")?.dataset.noteOverride === "true")
            throw new Error("This retry keeps the revised request’s saved notes. Use Edit on that request to change its notes, or select Use task defaults before retrying here. Your composer notes are kept.");
        if (scopedAttachments(scope).some(item => !(saved.attachments || []).some(attachment => attachment.id === item.id)))
            throw new Error("This is a saved revised request. Its original attachments are retained. Remove new composer attachments before retrying, or keep them for your next message.");
        captured = takeComposerDraft(scope);
        const result = await submitPromptRevision({ scope, task, message: { id: "revision-draft", role: "user", content: saved.prompt,
                attachments: saved.attachments, promptNotes: saved.promptNotes, pendingRevision: true }, prompt: draft.trim() });
        if (result.status === "saved")
            revisionComposerRetries.set(taskId, result.task);
        if (result.status === "started")
            revisionComposerRetries.delete(taskId);
        if (result.status !== "started")
            restoreComposerDraft(captured);
        return true;
    }
    catch (error) {
        if (captured)
            restoreComposerDraft(captured);
        toast(error.message, "error");
        return true;
    }
    finally {
        revisionComposerChecks.delete(taskId);
    }
}
const promptEditor = createPromptEditor({ document,
    createNoteFields: (host) => createPromptNoteFields(document, host),
    loadTask: (id) => api(`/api/ai-tasks/${encodeURIComponent(id)}`, { dedupe: false, cache: "no-store" }),
    beforeOpen: ({ task, scope }) => {
        if (activeTaskId(scope) !== task.id || (scope !== "global" && state.activeRepository?.id !== task.repositoryId))
            throw new Error("The active chat changed. Open Edit again in the chat you want to revise.");
        return closeOpenDialogs();
    }, submit: submitPromptRevision,
});
const recoverStoppedPrompt = createStoppedPromptRecovery({
    isCurrent: (scope, source) => composerRepositoryId(scope) === source.repositoryId
        && (activeTaskId(scope) || null) === (source.taskId || null)
        && state.currentView === (scope === "global" ? "global" : "repository"),
    loadTask: taskId => api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" }),
    openEditor: selection => promptEditor.open(selection),
    restoreDraft: restoreComposerDraft,
    onError: error => toast(`Response stopped. Your original request is still in this chat; use Edit to reopen it. ${error.message}`, "error"),
});
const chatRevisionViewer = createChatRevisionViewer({ document, api,
    renderMessage: renderChatMessage, renderAttachments: renderMessageAttachments,
    beforeOpen: ({ taskId, scope, dialogId }) => {
        if (activeTaskId(scope) !== taskId)
            throw new Error("Open this chat before viewing its previous versions.");
        return closeOpenDialogs(dialogId);
    },
});
const checkpointTasks = new Map();
const chatRevisionState = createChatRevisionState();
function acceptChatTaskSnapshot(scope, task) {
    return chatRevisionState.accept(task);
}
function acceptPromptRevision(scope, task) {
    if (!acceptChatTaskSnapshot(scope, task))
        return false;
    if (activeTaskId(scope) !== task.id || (scope !== "global" && state.activeRepository?.id !== task.repositoryId))
        return true;
    checkpointTasks.set(scope, checkpointActions.ingest(task));
    state.taskSelections ||= {};
    state.taskSelections[scope] = Symbol(task.id);
    checkpointNavigation.get(scope)?.resetSelection();
    const global = scope === "global";
    const selectedKey = global ? "globalJob" : "activeJob";
    const jobsKey = global ? "globalJobs" : "repositoryJobs";
    const selected = state[selectedKey];
    if (selected?.taskId === task.id && !chatRevisionState.acceptsJob(selected, task)) {
        state[selectedKey] = null;
        clearInterval(state[global ? "globalJobTimer" : "jobTimer"]);
    }
    state[jobsKey] = state[jobsKey].filter(job => chatRevisionState.acceptsJob(job, task));
    if (activeTaskId(scope) === task.id) {
        if (!state[selectedKey]) {
            $(global ? "#global-agent-output-card" : "#agent-output-card").classList.add("hidden");
            setComposerActionState(scope, false);
        }
        renderAgentQuestionForScope(scope);
        renderAgentTabs(scope);
    }
    return true;
}
const agentQuestionCards = createAgentQuestionCards({ document, api,
    createNoteFields: (host) => createPromptNoteFields(document, host),
    isCurrent: (scope, taskId) => state.currentView === (scope === "global" ? "global" : "repository") && activeTaskId(scope) === taskId,
    onAnswered: acceptAgentQuestionAnswer,
    onCancelled: acceptAgentQuestionCancellation,
});
function currentChatQuestionJob(scope, taskId) {
    const selected = scope === "global" ? state.globalJob : state.activeJob;
    const jobs = scope === "global" ? state.globalJobs : state.repositoryJobs;
    const eligible = job => job?.taskId === taskId && isChatAgentJob(job) && chatRevisionState.acceptsJob(job, checkpointTasks.get(scope));
    const latest = jobs.find(eligible);
    return eligible(selected) && (!latest || selected.id === latest.id) ? selected : latest;
}
function renderAgentQuestionForScope(scope) {
    const task = checkpointTasks.get(scope);
    const host = scope === "global" ? $("#global-agent-question-card-host") : $("#agent-question-card-host");
    const current = task?.id && activeTaskId(scope) === task.id;
    const detail = current && !task.revisionDraft ? chatQuestion(task, currentChatQuestionJob(scope, task.id)) : null;
    if (detail)
        detail.promptNotes = task.promptNotes || [];
    if (detail && composerSubmission(scope)?.taskId === task.id)
        detail.active = true;
    agentQuestionCards.render(host, { scope, taskId: current ? task.id : null, detail });
}
function agentJobStatusLabel(job) {
    const question = normalizeAgentQuestion(job.question);
    const task = [...checkpointTasks.values()].find((item) => item?.id === job.taskId);
    const cancelled = question && (agentQuestionCards.cancelled(job.taskId, question.id) || questionWasCancelled(task, question.id));
    if (cancelled && !agentJobIsActive(job))
        return "Request cancelled";
    if (question && !cancelled && !agentQuestionCards.answered(job.taskId, question.id)) {
        if (agentJobIsActive(job))
            return "Question from Argus";
        if (job.status === "completed")
            return questionCardTitle({ question, active: false, status: job.status });
    }
    return job.completionPending ? "Finalizing response" : ({ starting: "Starting", running: "Working", paused: "Paused", completed: "Completed", failed: "Failed", cancelled: "Cancelled" })[job.status] || job.status;
}
async function acceptAgentQuestionAnswer(job, { scope, taskId, questionId }) {
    const repositoryVisible = scope === "global" || state.activeRepository?.id === job.repositoryId;
    const jobs = scope === "global" ? state.globalJobs : repositoryVisible ? state.repositoryJobs : null;
    if (jobs) {
        const index = jobs.findIndex((item) => item.id === job.id);
        if (index >= 0)
            jobs[index] = job;
        else
            jobs.unshift(job);
    }
    const stillVisible = () => repositoryVisible && (scope === "global" || state.activeRepository?.id === job.repositoryId)
        && state.currentView === (scope === "global" ? "global" : "repository") && activeTaskId(scope) === taskId;
    if (stillVisible()) {
        if (scope === "global")
            showGlobalJob(job);
        else
            showRepositoryJob(job);
        renderAgentQuestionForScope(scope);
    }
    let task;
    try {
        task = await api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" });
    }
    catch {
        if (stillVisible())
            toast("Your reply was sent. Refresh this chat to see the continuing response.");
        return;
    }
    if (stillVisible()) {
        renderTaskConversation(scope, task);
        renderAgentTabs(scope);
        toast(queuedPrompts(scope, taskId).length ? "Reply sent. Your saved queue remains paused; resume it when ready." : "Reply sent · Argus is continuing");
    }
}
async function acceptAgentQuestionCancellation(result, { scope, taskId, questionId }) {
    const queue = queuedPrompts(scope, taskId);
    for (const item of queue) {
        item.recovered = true;
        item.pauseReason = "question-cancelled";
    }
    const task = result.task;
    const job = result.job;
    const repositoryVisible = () => scope === "global" || state.activeRepository?.id === task?.repositoryId;
    const stillVisible = () => repositoryVisible() && state.currentView === (scope === "global" ? "global" : "repository") && activeTaskId(scope) === taskId;
    if (task?.id === taskId && repositoryVisible() && activeTaskId(scope) === taskId)
        checkpointTasks.set(scope, task);
    if (job?.taskId === taskId) {
        const jobs = scope === "global" ? state.globalJobs : repositoryVisible() ? state.repositoryJobs : null;
        if (jobs) {
            const index = jobs.findIndex((item) => item.id === job.id);
            if (index >= 0)
                jobs[index] = job;
            else
                jobs.unshift(job);
        }
        if (stillVisible()) {
            if (scope === "global")
                showGlobalJob(job);
            else
                showRepositoryJob(job);
        }
    }
    if (stillVisible() && task?.id === taskId) {
        renderTaskConversation(scope, task);
        renderAgentTabs(scope);
    }
    try {
        const saved = await api(`/api/prompt-queue?taskId=${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" });
        queue.splice(0, queue.length, ...saved.map((item) => ({ ...item, recovered: true })));
        state.promptQueuesLoaded.add(taskId);
    }
    catch {
        if (stillVisible())
            toast("Request cancelled. Queued messages remain paused; refresh this chat to check the saved queue.");
        return;
    }
    if (stillVisible()) {
        if (task?.id === taskId)
            renderTaskConversation(scope, task);
        toast(queue.length ? "Request cancelled. Queued messages are kept and paused; choose Resume queue when ready." : "Request cancelled · this chat has stopped");
    }
}
const checkpointNavigation = new Map();
const checkpointActions = createChatCheckpointActions({
    api,
    getTask: (scope) => checkpointTasks.get(scope),
    isActive: (scope, taskId) => activeTaskId(scope) === taskId,
    onChange: paintCheckpointChanges,
    onError: (message) => toast(message, "error"),
});
function messageCheckpointButton(task, message) {
    if (!task?.id || !isCheckpointEligible(message))
        return "";
    return checkpointButtonMarkup({ taskId: task.id, messageId: message.id,
        marked: task.checkpoints?.some((item) => item.messageId === message.id),
        pending: checkpointActions.isPending(task.id), escapeHtml });
}
function paintCheckpointChanges(scope, taskId) {
    const current = checkpointTasks.get(scope);
    if (current?.id !== taskId || activeTaskId(scope) !== taskId)
        return;
    const task = checkpointActions.ingest(current);
    checkpointTasks.set(scope, task);
    const scroller = conversationScroller(scope);
    const snapshot = captureLiveScroll(scroller);
    const conversation = scope === "global" ? $("#global-agent-conversation") : $("#agent-conversation");
    const marked = new Set((task.checkpoints || []).map((item) => item.messageId));
    const saved = new Map((task.messages || []).map((message) => [message.id, message]));
    for (const article of conversation.querySelectorAll("article[data-chat-message-id]")) {
        const id = article.dataset.chatMessageId;
        if (!marked.has(id) && !saved.has(id)) {
            article.remove();
            continue;
        }
        article.dataset.chatCheckpoint = String(marked.has(id));
        const button = article.querySelector("[data-checkpoint-message]");
        if (button) {
            const active = marked.has(id);
            const action = active ? "Remove checkpoint" : "Add checkpoint";
            button.setAttribute("aria-pressed", String(active));
            button.setAttribute("aria-label", action);
            button.title = `${action} · saved in this chat only`;
            button.disabled = checkpointActions.isPending(taskId);
            button.querySelector("span").textContent = active ? "Checkpoint" : "Mark";
        }
    }
    restoreLiveScroll(scroller, snapshot);
    checkpointNavigation.get(scope)?.refresh();
}
function renderTaskConversation(scope, task) {
    if (!acceptChatTaskSnapshot(scope, task))
        return;
    if (scope === "repository")
        $("#repository-workbench")?.classList.toggle("code-discussions-task", task?.codeDiscussionTask === true);
    task = checkpointActions.ingest(task);
    taskPromptNotes.sync(scope, task);
    checkpointTasks.set(scope, task);
    const target = scope === "global" ? $("#global-agent-conversation") : $("#agent-conversation");
    const scrollState = captureLiveScroll(conversationScroller(scope));
    const messages = conversationMessagesWithCheckpoints(task);
    const codeAnchors = new Map((task?.codeDiscussionTask === true ? task.codeDiscussions?.discussions || [] : []).map(item => [item.id, item.anchor]));
    const checkpointIds = new Set((task?.checkpoints || []).map((item) => item.messageId));
    const savedIds = new Set((task?.messages || []).map((item) => item.id));
    const submission = composerSubmission(scope);
    const repositoryMatches = scope === "global" || submission?.repositoryId === state.activeRepository?.id;
    const taskMatches = submission?.taskId === (task?.id || null);
    const alreadyPersisted = submission && messages.some((message) => message.role === "user" && message.content === submission.prompt && new Date(message.createdAt).getTime() >= submission.startedAt - 2000);
    if (submission && repositoryMatches && taskMatches && !alreadyPersisted) {
        messages.push({ role: "user", content: submission.prompt, promptNotes: submission.promptNotes, attachments: submission.attachments, createdAt: submission.createdAt, optimistic: true, requestId: submission.requestId });
    }
    if (task?.revisionDraft && !submission)
        messages.push({ id: "revision-draft", role: "user", content: task.revisionDraft.prompt, promptNotes: task.revisionDraft.promptNotes, attachments: task.revisionDraft.attachments, pendingRevision: true });
    for (const [index, queued] of queuedPrompts(scope, task?.id).entries())
        messages.push({ role: "user", content: queued.prompt, promptNotes: queued.promptNotes, attachments: queued.attachments, createdAt: queued.createdAt, optimistic: true, queued: true, queuePosition: index + 1, savedQueue: queued });
    target.classList.toggle("is-empty", !messages.length);
    if (scope === "repository")
        $(".ai-main-content > .suggestion-row")?.classList.toggle("hidden", Boolean(messages.length));
    const messageMarkup = messages.length ? messages.map((message, index) => {
        const user = message.role === "user";
        const anchor = user && codeAnchors.get(message.codeDiscussionId);
        const codeSnapshot = anchor ? `<details class="code-discussion-message-anchor"><summary>${anchor.side === "before" ? "Before diff" : anchor.side === "after" ? "After diff" : "Source"} · ${escapeHtml(anchor.path)}:${escapeHtml(anchor.line)} · saved snapshot${anchor.unsaved ? " · unsaved" : ""}</summary><pre>${escapeHtml(anchor.selection)}</pre></details>` : "";
        const timestamp = formatMessageTimestamp(message.createdAt);
        const answerLabel = user ? "" : `<div class="chat-answer-label"><span>Answer</span></div>`;
        const queueLabel = message.pendingRevision ? ' · <span class="queued-prompt-label">Revised draft · saved</span>' : message.queued ? ` · <span class="queued-prompt-label">Queued${message.queuePosition ? ` · ${message.queuePosition}` : ""}</span>` : message.role === "user" && message.status === "steered" && message.steering?.requestId && message.steering.jobId && message.steering.turnId ? ' · <span class="queued-prompt-label" title="Sent into the active response without stopping it">Steered</span>' : "";
        const saved = message.savedQueue;
        const recovered = saved && (saved.recovered || ["interrupted", "dispatching"].includes(saved.status));
        const queueControls = recovered ? `<div class="saved-queue-notice"><p>${escapeHtml(saved.delivery === "steer" && saved.status !== "queued" ? saved.error || "Steering may already have been accepted. Check this chat before resending this message." : saved.status === "queued" ? saved.pauseReason === "question-cancelled" ? "Request cancelled. Your queued messages are kept and paused. Resume only when you want this chat to continue." : saved.pauseReason === "question-action" ? "Queue paused while handling Argus’s question. Your queued messages are kept; resume when ready." : saved.pauseReason === "question" ? "Queue paused for Argus’s question. Answer or cancel the request first, then resume when ready. Your queued messages are kept." : "Saved queue paused after reload. Resume when ready." : "Dispatch was interrupted. Check the chat before resending; this request may already have started.")}</p>${saved.status === "queued" ? `<button type="button" data-resume-queue="${escapeHtml(task.id)}" data-queue-scope="${scope}">Resume queue</button>` : saved.status === "interrupted" ? `<button type="button" data-discard-queued="${escapeHtml(saved.requestId)}" data-queue-scope="${scope}" data-queue-task="${escapeHtml(task.id)}">Remove from queue</button>` : ""}</div>` : "";
        const archivedCheckpoint = checkpointIds.has(message.id) && !savedIds.has(message.id);
        const checkpointAttributes = isCheckpointEligible(message) ? ` data-chat-message-id="${escapeHtml(message.id)}" data-chat-checkpoint="${checkpointIds.has(message.id)}"` : "";
        const renderKey = `${task?.id || scope}:${message.id || saved?.requestId || message.requestId || `message-${index}`}`;
        return `<article data-chat-render-key="${escapeHtml(renderKey)}" class="chat-message ${user ? "user" : "assistant"}${message.optimistic ? " optimistic" : ""}${message.queued ? " queued" : ""}"${checkpointAttributes}>${user ? "" : '<span class="chat-avatar"><img src="/assets/argus-logo.svg" alt="" /></span>'}<div class="chat-message-body"><div class="chat-message-meta">${user ? "You" : "Argus"}${timestamp ? ` · <time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(timestamp)}</time>` : ""}${queueLabel}${saved ? queuedPromptButtons(scope, task.id, saved, { job: scope === "global" ? state.globalJob : state.activeJob }) : archivedCheckpoint ? "" : promptEditButton(scope, task, message)}${messageCheckpointButton(task, message)}${archivedCheckpoint ? '<span class="checkpoint-archive-note"> · Saved checkpoint from earlier history</span>' : ""}</div>${answerLabel}<div class="chat-message-content">${codeSnapshot}${user ? renderMessageAttachments(message.attachments) : ""}${renderChatMessage(message.content)}${user ? sentPromptNotesMarkup(message.promptNotes) : ""}${queueControls}</div></div></article>`;
    }).join("") : emptyConversationMarkup(scope);
    const codeDiscussionBanner = scope === "repository" && task?.codeDiscussionTask === true
        ? `<div class="code-discussions-task-notice" data-chat-render-key="${escapeHtml(task.id)}:code-notice"><p>All inline code conversations are saved here. Continue a discussion beside its code, or choose a saved discussion.</p><button type="button">Open code discussions</button></div>` : "";
    renderChatMarkup(target, (revisionHistoryButton(task, scope) || "") + codeDiscussionBanner + messageMarkup);
    if (scope === "repository" && task?.codeDiscussionTask === true) {
        const repositoryId = task.repositoryId;
        target.querySelector(".code-discussions-task-notice button").onclick = () => {
            if (state.activeRepository?.id === repositoryId)
                void repositoryIdeBridge.openCodeDiscussions(repositoryId);
        };
    }
    renderAgentQuestionForScope(scope);
    restoreLiveScroll(conversationScroller(scope), scrollState);
    checkpointNavigation.get(scope)?.setTask(task?.id || null);
    checkpointNavigation.get(scope)?.refresh();
}
function appendOptimisticUserMessage(scope, submission) {
    const task = checkpointTasks.get(scope);
    renderTaskConversation(scope, task?.id === submission.taskId ? task
        : { id: submission.taskId, repositoryId: submission.repositoryId, messages: [] });
    scrollConversationToBottom(scope);
}
function scrollConversationToBottom(scope) {
    const taskId = activeTaskId(scope);
    requestAnimationFrame(() => {
        if (activeTaskId(scope) !== taskId)
            return;
        const scroller = conversationScroller(scope);
        if (scroller)
            scroller.scrollTop = scroller.scrollHeight;
        checkpointNavigation.get(scope)?.resetSelection();
    });
}
const LIVE_SCROLL_EDGE_THRESHOLD = 48;
function conversationScroller(scope) {
    return scope === "global" ? $(".global-chat-scroll-region") : $("#agent-conversation")?.closest(".chat-scroll-region");
}
function captureLiveScroll(element) {
    if (!element)
        return null;
    return {
        top: element.scrollTop,
        followsLiveEdge: element.scrollHeight - element.scrollTop - element.clientHeight <= LIVE_SCROLL_EDGE_THRESHOLD,
    };
}
function restoreLiveScroll(element, snapshot) {
    if (!element || !snapshot)
        return;
    element.scrollTop = snapshot.followsLiveEdge
        ? element.scrollHeight
        : Math.min(snapshot.top, Math.max(0, element.scrollHeight - element.clientHeight));
}
async function selectTask(scope, taskId, { background = false, dismissTaskHistory = false, isCurrent = () => true } = {}) {
    state.taskSelections ||= {};
    const selection = state.taskSelections[scope] = Symbol(taskId);
    const repositoryId = state.activeRepository?.id;
    const task = await api(`/api/ai-tasks/${taskId}`, { dedupe: false, cache: "no-store" });
    if (!state.promptQueuesLoaded.has(taskId) && !state.promptQueueProcessors.has(`${scope}:${taskId}`)) {
        try {
            const saved = await api(`/api/prompt-queue?taskId=${encodeURIComponent(taskId)}`);
            if (!state.promptQueuesLoaded.has(taskId) && !state.promptQueueProcessors.has(`${scope}:${taskId}`) && !state.promptQueueSaves.has(taskId)) {
                const queues = scope === "global" ? state.globalPromptQueues : state.repositoryPromptQueues;
                queues[taskId] = saved.map((request) => ({ ...request, recovered: true }));
                state.promptQueuesLoaded.add(taskId);
            }
        }
        catch (error) {
            toast(`Saved queue could not be loaded: ${error.message}`, "error");
        }
    }
    if (!isCurrent() || state.taskSelections[scope] !== selection || (scope !== "global" && (state.activeRepository?.id !== repositoryId || task.repositoryId !== repositoryId)))
        return;
    if (!acceptChatTaskSnapshot(scope, task))
        return;
    if (background) {
        if (state.currentView !== (scope === "global" ? "global" : "repository") || document.body.classList.contains("version-control-dock-open"))
            return;
    }
    else {
        if (!showTaskWorkspace(scope))
            return;
        if (scope !== "global" && dismissTaskHistory && document.body.classList.contains("repository-ide-enabled")) {
            setTaskPanelCollapsed(scope, true, false);
            if (document.body.classList.contains("repository-ide-chat-hidden"))
                repositoryIdeBridge.setChatVisible(true);
        }
    }
    if (scope === "global")
        state.activeGlobalTaskId = taskId;
    else
        state.activeTaskByRepository[state.activeRepository.id] = taskId;
    renderTaskList(scope);
    restoreTaskModelSettings(scope, task);
    renderContextTray(scope);
    renderTaskConversation(scope, task);
    syncViewUrl(scope === "global" ? "global" : "repository");
    const runningJob = (scope === "global" ? state.globalJobs : state.repositoryJobs).find((job) => job.taskId === taskId && agentJobIsActive(job) && chatRevisionState.acceptsJob(job, task));
    if (runningJob)
        return scope === "global" ? showGlobalJob(runningJob) : showRepositoryJob(runningJob);
    const card = scope === "global" ? $("#global-agent-output-card") : $("#agent-output-card");
    const submission = composerSubmission(scope);
    if (submission)
        setComposerPreparingState(scope, true, submission.providerName);
    else {
        card.classList.add("hidden");
        setComposerActionState(scope, false);
    }
    if (!background && !task.messages?.length) {
        const promptBox = scope === "global" ? $("#global-agent-prompt") : $("#agent-prompt");
        promptBox.focus();
        return;
    }
}
function closeOpenDialogs(exceptId = "") {
    const diffDialog = $("#diff-dialog");
    if (diffDialog?.open && diffDialog.id !== exceptId && state.diffEditor?.busy)
        return false;
    if (diffDialog?.open && diffDialog.id !== exceptId && diffEditIsDirty()
        && !confirm("Close the diff and discard your unsaved edits?"))
        return false;
    $$("dialog[open]").forEach((dialog) => {
        if (dialog.id === exceptId || dialog.id === "prompt-edit-dialog" || dialog.id === "revision-scope-dialog" || dialog.id === "queued-prompt-edit-dialog" || dialog.id === "task-notes-dialog" || dialog.id === "git-stash-dialog" || dialog.id === "daily-planner-dialog")
            return;
        dialog.close();
        if (dialog.id === "diff-dialog")
            state.diffEditor = null;
    });
    closeFindBar();
    return true;
}
function appNavigationSnapshot() {
    const repository = state.currentView === "repository" ? state.activeRepository : null;
    return { route: pathForView(state.currentView), repositoryId: repository?.id || null,
        editor: repository ? repositoryIdeBridge.getNavigationState() : null,
        gitOpen: Boolean(repository && document.body.classList.contains("version-control-dock-open")) };
}
function syncAppNavigationButtons() {
    for (const [direction, count] of [["back", appNavigationHistory.backCount], ["forward", appNavigationHistory.forwardCount]]) {
        const button = $(`#app-navigation-${direction}`);
        if (!button)
            continue;
        button.disabled = appNavigationRestoring || count === 0;
        button.title = `${direction === "back" ? "Back" : "Forward"} · ${count} ${count === 1 ? "state" : "states"} available (maximum 10)`;
    }
}
function queueAppNavigation({ replace = false } = {}) {
    if (!state.navigationReady || state.restoringRoute || appNavigationRestoring || appNavigationScheduled)
        return;
    appNavigationScheduled = true;
    queueMicrotask(() => {
        appNavigationScheduled = false;
        if (!state.restoringRoute && !appNavigationRestoring) {
            const snapshot = appNavigationSnapshot();
            appNavigationHistory.record(snapshot, { replace: replace && appNavigationHistory.current?.route === snapshot.route });
            syncAppNavigationButtons();
        }
    });
}
async function restoreAppNavigation(snapshot, isCurrent = () => true) {
    if (!isCurrent())
        return false;
    window.history.replaceState({ view: state.currentView }, "", snapshot.route);
    await restoreRoute({ isCurrent });
    if (!isCurrent())
        return false;
    if (snapshot.repositoryId && state.activeRepository?.id === snapshot.repositoryId && state.currentView === "repository") {
        const editor = snapshot.editor;
        if (!await repositoryIdeBridge.setEnabled(snapshot.repositoryId, Boolean(editor?.enabled)))
            throw new Error("The editor could not restore this repository.");
        if (!isCurrent())
            return false;
        if (editor?.enabled) {
            repositoryIdeBridge.setChatVisible(editor.chatVisible !== false);
            if (editor.path) {
                const restored = editor.surface === "diff" ? await showDiff(editor.path, Boolean(editor.staged), editor, isCurrent)
                    : await repositoryIdeBridge.restoreLocation(snapshot.repositoryId, editor, isCurrent);
                if (!isCurrent())
                    return false;
                if (!restored)
                    throw new Error("That file or diff could not be reopened; your navigation history is unchanged.");
            }
        }
        setVersionControlDockOpen(snapshot.gitOpen, false);
    }
    return true;
}
async function moveAppNavigation(direction) {
    if (appNavigationRestoring || !appNavigationHistory.peek(direction) || !closeOpenDialogs())
        return;
    const previous = appNavigationSnapshot();
    appNavigationHistory.record(previous, { replace: true });
    const destination = appNavigationHistory.peek(direction);
    const revision = ++appNavigationRevision;
    const isCurrent = () => appNavigationRevision === revision;
    appNavigationRestoring = true;
    syncAppNavigationButtons();
    try {
        if (!await restoreAppNavigation(destination, isCurrent) || !isCurrent())
            return;
        appNavigationHistory.move(direction);
        appNavigationHistory.record(appNavigationSnapshot(), { replace: true });
    }
    catch (error) {
        if (!isCurrent())
            return;
        try {
            await restoreAppNavigation(previous, isCurrent);
        }
        catch { }
        toast(`Could not restore that view: ${error.message}`, "error");
    }
    finally {
        if (isCurrent())
            appNavigationRestoring = false;
        syncAppNavigationButtons();
    }
}
function cancelPendingAppNavigation(event) {
    if (!appNavigationRestoring || event.target?.closest?.(".app-navigation"))
        return;
    if (event.type === "keydown" && ["Control", "Meta", "Alt", "Shift"].includes(event.key))
        return;
    appNavigationRevision++;
    appNavigationRestoring = false;
    state.restoringRoute = false;
    state.routeRestoreSequence = (state.routeRestoreSequence || 0) + 1;
    syncAppNavigationButtons();
}
function pathForView(view) {
    if (view === "daily-planner")
        return "/daily-tasks";
    if (view === "diagrams")
        return "/diagram-studio";
    if (view === "services")
        return "/services";
    if (view === "api")
        return "/api-client";
    if (view === "json")
        return "/json-explorer";
    if (view === "global")
        return state.activeGlobalTaskId ? `/global-ai/tasks/${encodeURIComponent(state.activeGlobalTaskId)}` : "/global-ai";
    if (view === "ai")
        return "/ai-connections";
    if (!state.activeRepository)
        return "/";
    const repositoryPath = `/repositories/${encodeURIComponent(state.activeRepository.id)}`;
    const taskId = state.activeTaskByRepository[state.activeRepository.id];
    return taskId ? `${repositoryPath}/tasks/${encodeURIComponent(taskId)}` : repositoryPath;
}
function syncViewUrl(view, replace = false) {
    if (!state.navigationReady || state.restoringRoute)
        return;
    const nextPath = pathForView(view);
    if (window.location.pathname !== nextPath)
        window.history[replace ? "replaceState" : "pushState"]({ view }, "", nextPath);
    queueAppNavigation({ replace });
}
function switchPrimaryView(view = "repository", options = {}) {
    if (!closeOpenDialogs())
        return false;
    state.currentView = view;
    document.body.dataset.view = view;
    document.body.classList.toggle("workspace-tool-active", view !== "repository" && view !== "global" && Boolean(state.activeRepository));
    $("#global-codex-panel").classList.toggle("hidden", view !== "global");
    $("#api-client-drawer").classList.toggle("hidden", view !== "api");
    $("#json-explorer-panel").classList.toggle("hidden", view !== "json");
    if (view !== "services" && (state.activeLogConfigurationId || state.activeLogProcessId))
        closeServiceLogs();
    $("#services-drawer").classList.toggle("hidden", view !== "services");
    $("#daily-planner-panel")?.classList.toggle("hidden", view !== "daily-planner");
    $("#diagram-studio-panel")?.classList.toggle("hidden", view !== "diagrams");
    if (typeof dailyPlanner !== "undefined") {
        if (view === "daily-planner")
            void dailyPlanner?.open();
        else
            dailyPlanner?.close();
    }
    const buttons = { api: $("#api-client-toggle"), json: $("#json-explorer-toggle"), services: $("#services-toggle"), ai: $("#ai-status-pill") };
    Object.entries(buttons).forEach(([name, button]) => {
        const active = name === view;
        button?.classList.toggle("view-active", active);
        if (active)
            button?.setAttribute("aria-current", "page");
        else
            button?.removeAttribute("aria-current");
    });
    const nexusShortcut = $("#nexus-shortcut");
    nexusShortcut?.classList.toggle("view-active", view === "global");
    nexusShortcut?.setAttribute("aria-pressed", String(view === "global"));
    if (view === "global")
        nexusShortcut?.setAttribute("aria-current", "page");
    else
        nexusShortcut?.removeAttribute("aria-current");
    if (view !== "repository")
        setVersionControlDockOpen(false, false);
    syncRepositoryTabSelection();
    syncWorkspaceRail();
    if (options.updateUrl !== false)
        syncViewUrl(view, options.replace === true);
    if (typeof repositoryIdeBridge !== "undefined")
        void repositoryIdeBridge.sync(view === "repository");
    if (view === "services") {
        renderServices();
        void refreshRuntimeDetections();
        void refreshProcesses();
    }
    return true;
}
function isRepositoryDestination(repositoryId) {
    return state.currentView === "repository" && repositoryId === state.activeRepository?.id;
}
function syncRepositoryTabSelection() {
    $$("#repo-tabs [data-repository-tab]").forEach((tab) => {
        const active = isRepositoryDestination(tab.dataset.repositoryTab);
        tab.classList.toggle("active", active);
        const button = tab.querySelector(".repo-tab-main");
        if (active)
            button?.setAttribute("aria-current", "page");
        else
            button?.removeAttribute("aria-current");
    });
    const activeGroups = new Set(repositoryTabGroups().filter((group) => group.repositoryIds.some(isRepositoryDestination)).map((group) => group.id));
    $$("#repo-tabs [data-tab-group]").forEach((group) => {
        group.classList.toggle("contains-active", activeGroups.has(group.dataset.tabGroup));
    });
}
async function restoreRoute({ isCurrent = () => true } = {}) {
    if (!state.navigationReady)
        return;
    const revision = state.routeRestoreSequence = (state.routeRestoreSequence || 0) + 1;
    const valid = () => isCurrent() && state.routeRestoreSequence === revision;
    state.restoringRoute = true;
    try {
        const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
        const repositoryMatch = pathname.match(/^\/repositories\/([^/]+)(?:\/tasks\/([^/]+))?$/);
        if (repositoryMatch) {
            const repositoryId = decodeURIComponent(repositoryMatch[1]);
            if (state.workspace.repositories.some((item) => item.id === repositoryId)) {
                await activateRepository(repositoryId);
                if (!valid())
                    return;
                const taskId = repositoryMatch[2] ? decodeURIComponent(repositoryMatch[2]) : null;
                if (taskId && taskList("repository").some((task) => task.id === taskId))
                    await selectTask("repository", taskId, { isCurrent: valid });
            }
            else {
                switchPrimaryView("repository", { updateUrl: false });
                window.history.replaceState({ view: "repository" }, "", pathForView("repository"));
            }
        }
        else if (pathname === "/daily-tasks") {
            switchPrimaryView("daily-planner", { updateUrl: false });
        }
        else if (pathname === "/diagram-studio") {
            switchPrimaryView("diagrams", { updateUrl: false });
        }
        else if (pathname === "/services") {
            switchPrimaryView("services", { updateUrl: false });
        }
        else if (pathname === "/api-client")
            await openApiClient();
        else if (pathname === "/json-explorer")
            openJsonExplorer();
        else if (pathname === "/global-ai" || pathname.startsWith("/global-ai/tasks/")) {
            await openGlobalCodex({ isCurrent: valid });
            if (!valid())
                return;
            const taskId = pathname.match(/^\/global-ai\/tasks\/([^/]+)$/)?.[1];
            if (taskId && taskList("global").some((task) => task.id === decodeURIComponent(taskId)))
                await selectTask("global", decodeURIComponent(taskId), { isCurrent: valid });
        }
        else if (pathname === "/ai-connections") {
            switchPrimaryView("repository", { updateUrl: false });
            showAppDialog("ai-connections-dialog");
            renderAIConnections();
        }
        else {
            switchPrimaryView("repository", { updateUrl: false });
            window.history.replaceState({ view: "repository" }, "", pathForView("repository"));
        }
    }
    finally {
        if (state.routeRestoreSequence === revision) {
            state.restoringRoute = false;
            queueAppNavigation();
        }
    }
}
function showAppDialog(dialogId) {
    if (!closeOpenDialogs(dialogId))
        return false;
    const dialog = $(`#${dialogId}`);
    if (!dialog.open)
        dialog.show();
    return true;
}
function openJsonExplorer() {
    if (!switchPrimaryView("json"))
        return false;
    jsonExplorer.show();
    return true;
}
function switchProjectStructureSection(section) {
    $$('[data-project-section]').forEach((button) => {
        const active = button.dataset.projectSection === section;
        button.classList.toggle("active", active);
        button.setAttribute("aria-current", active ? "page" : "false");
    });
    $$('[data-project-pane]').forEach((pane) => pane.classList.toggle("hidden", pane.dataset.projectPane !== section));
    const content = $(".project-structure-content");
    if (content)
        content.scrollTop = 0;
}
function renderProjectStructure(project) {
    state.javaProject = project;
    $("#project-structure-loading").classList.add("hidden");
    switchProjectStructureSection("project");
    $("#project-module-count").textContent = project.modules.length;
    if (project.projectType === "node")
        renderNodeProjectStructure(project);
    else if (project.projectType === "python")
        renderPythonProjectStructure(project);
    else if (project.projectType === "generic")
        renderGenericProjectStructure(project);
    else
        renderJavaProjectStructure(project);
}
function moduleCards(project, emptyMessage) {
    return project.modules.map((module) => `<article class="java-module-card"><header><div><span>▦</span><strong>${escapeHtml(module.name)}</strong></div><code>${escapeHtml(module.path)}</code></header><div class="module-roots">${module.roots.length ? module.roots.map((root) => `<div><span class="root-type ${root.type.toLowerCase().replaceAll(" ", "-")}">${escapeHtml(root.type)}</span><code>${escapeHtml(root.path)}</code></div>`).join("") : `<p>${escapeHtml(emptyMessage)}</p>`}</div>${module.compilerOutput ? `<footer><span>Output</span><code>${escapeHtml(module.compilerOutput)}</code></footer>` : ""}</article>`).join("") || `<div class="empty-list">No modules detected.</div>`;
}
function renderNodeProjectStructure(project) {
    const runtime = project.runtime;
    $("#project-type-eyebrow").textContent = "NODE / UI PROJECT";
    $("#project-structure-subtitle").textContent = `${project.repository.name} · ${project.framework} · ${runtime.packageManager}`;
    $("#project-platform-label").textContent = "TOOLCHAIN";
    $("#project-runtime-label").textContent = "Runtime";
    $("#project-sdk-count").textContent = "";
    $('[data-project-section="build"]').childNodes[0].textContent = "Scripts ";
    $("#save-project-structure").classList.add("hidden");
    $('[data-project-pane="project"]').innerHTML = `<header><h3>${escapeHtml(project.framework)} project</h3><p>Node and frontend settings detected directly from this repository.</p></header><div class="node-overview-grid"><article><small>PACKAGE</small><strong>${escapeHtml(project.repository.name)}</strong><code>package.json</code></article><article><small>FRAMEWORK</small><strong>${escapeHtml(project.framework)}</strong><span>Detected from dependencies and scripts</span></article><article><small>NODE</small><strong>${escapeHtml(runtime.nodeVersion)}</strong><span>${runtime.configuredNode ? `Project requests ${escapeHtml(runtime.configuredNode)}` : "No project version pinned"}</span></article><article><small>DEPENDENCIES</small><strong>${project.dependencies.production} runtime · ${project.dependencies.development} development</strong><span>${runtime.dependenciesInstalled ? "node_modules is present" : "node_modules is not installed"}</span></article></div><div class="project-safety-note"><span>✓</span><div><strong>Repository files remain the source of truth</strong><small>Argus reads package.json, lockfiles and Node version files without rewriting them.</small></div></div>`;
    $('[data-project-pane="modules"]').innerHTML = `<header><h3>Project folders</h3><p>Source roots and package workspaces detected in this repository.</p></header><div class="java-module-list">${moduleCards(project, "No conventional UI source folders detected.")}</div>`;
    $('[data-project-pane="sdks"]').innerHTML = `<header><h3>Node runtime</h3><p>Runtime and dependency information available to Argus on this Mac.</p></header><div class="node-runtime-list"><article><span class="node-runtime-badge">JS</span><div><strong>Node ${escapeHtml(runtime.nodeVersion)}</strong><small>Required: ${escapeHtml(runtime.requiredNode || "Not specified in package.json")}</small><code>${escapeHtml(runtime.configuredNode ? `Configured: ${runtime.configuredNode}` : "No .nvmrc or .node-version")}</code></div></article><article><span class="node-runtime-badge package">PM</span><div><strong>${escapeHtml(runtime.packageManager)} ${escapeHtml(runtime.packageManagerVersion)}</strong><small>${escapeHtml(runtime.declaredPackageManager || "Selected from repository lockfile")}</small><code>${escapeHtml(project.build.files.join(" · "))}</code></div></article><article class="dependency-runtime-card"><span class="dependency-state ${runtime.dependenciesInstalled ? "ready" : "missing"}"></span><div><strong>${runtime.dependenciesInstalled ? "Dependencies installed" : "Dependencies needed"}</strong><small>${escapeHtml(runtime.dependencyDirectory)} ${runtime.dependenciesInstalled ? "is available" : "is missing"}</small></div></article></div>`;
    $('[data-project-pane="build"]').innerHTML = `<header><h3>Package scripts</h3><p>Commands detected from package.json. Run operational actions from Services.</p></header><div class="node-script-list">${project.scripts.map((script) => `<article><div><strong>${escapeHtml(script.name)}</strong><code>${escapeHtml(script.command)}</code></div></article>`).join("") || `<div class="empty-list">No package scripts detected.</div>`}</div>`;
    $("#project-structure-status").textContent = "Project Structure is informational; dependency sync and tests are available in Services.";
}
function renderPythonProjectStructure(project) {
    const runtime = project.runtime;
    $("#project-type-eyebrow").textContent = project.framework === "FastMCP" ? "PYTHON / MCP PROJECT" : "PYTHON PROJECT";
    $("#project-structure-subtitle").textContent = `${project.repository.name} · ${project.framework} · ${runtime.packageManager}`;
    $("#project-platform-label").textContent = "TOOLCHAIN";
    $("#project-runtime-label").textContent = "Runtime";
    $("#project-sdk-count").textContent = "";
    $('[data-project-section="build"]').childNodes[0].textContent = "Commands ";
    $("#save-project-structure").classList.add("hidden");
    $('[data-project-pane="project"]').innerHTML = `<header><h3>${escapeHtml(project.framework)} project</h3><p>Python application settings detected from repository files and imports.</p></header><div class="node-overview-grid"><article><small>PROJECT</small><strong>${escapeHtml(project.repository.name)}</strong><code>${escapeHtml(runtime.entryPoint || "No entry point detected")}</code></article><article><small>FRAMEWORK</small><strong>${escapeHtml(project.framework)}</strong><span>Detected from dependencies and source</span></article><article><small>PYTHON</small><strong>${escapeHtml(runtime.pythonVersion)}</strong><span>${runtime.configuredPython ? `Project requests ${escapeHtml(runtime.configuredPython)}` : "No project version pinned"}</span></article><article><small>DEPENDENCIES</small><strong>${project.dependencies.production} declared</strong><span>${runtime.virtualEnvironment ? `${escapeHtml(runtime.virtualEnvironment)} is present` : "No local virtual environment detected"}</span></article></div><div class="project-safety-note"><span>✓</span><div><strong>Analyzer-derived project model</strong><small>Argus reads Python metadata and source layout without rewriting project files.</small></div></div>`;
    $('[data-project-pane="modules"]').innerHTML = `<header><h3>Project folders</h3><p>Python sources, tools, tests and configuration roots.</p></header><div class="java-module-list">${moduleCards(project, "No conventional Python source folders detected.")}</div>`;
    $('[data-project-pane="sdks"]').innerHTML = `<header><h3>Python runtime</h3><p>Interpreter, dependency manager and environment information.</p></header><div class="node-runtime-list"><article><span class="node-runtime-badge">PY</span><div><strong>${escapeHtml(runtime.pythonVersion)}</strong><small>Required: ${escapeHtml(runtime.configuredPython || "Not specified")}</small><code>${escapeHtml(runtime.entryPoint || "No entry point detected")}</code></div></article><article><span class="node-runtime-badge package">PM</span><div><strong>${escapeHtml(runtime.packageManager)} ${escapeHtml(runtime.packageManagerVersion)}</strong><small>${runtime.virtualEnvironment ? `Environment: ${escapeHtml(runtime.virtualEnvironment)}` : "No .venv or venv detected"}</small><code>${escapeHtml(project.build.files.join(" · "))}</code></div></article><article class="dependency-runtime-card"><span class="dependency-state ${runtime.dependenciesInstalled ? "ready" : "missing"}"></span><div><strong>${runtime.dependenciesInstalled ? "Python environment detected" : "Dependencies can be installed"}</strong><small>${escapeHtml(runtime.installCommand)}</small></div></article></div>`;
    $('[data-project-pane="build"]').innerHTML = `<header><h3>Detected commands</h3><p>Commands detected from the repository. Run operational actions from Services.</p></header><div class="node-script-list">${project.scripts.map((script) => `<article><div><strong>${escapeHtml(script.name)}</strong><code>${escapeHtml(script.command)}</code></div></article>`).join("") || `<div class="empty-list">No safe runnable command was detected.</div>`}</div>`;
    $("#project-structure-status").textContent = "Project Structure is informational; dependency sync and tests are available in Services.";
}
function renderGenericProjectStructure(project) {
    $("#project-type-eyebrow").textContent = "REPOSITORY PROJECT";
    $("#project-structure-subtitle").textContent = `${project.repository.name} · ${project.framework}`;
    $("#project-platform-label").textContent = "DETECTION";
    $("#project-runtime-label").textContent = "Languages";
    $("#project-sdk-count").textContent = project.runtime.languages.length;
    $('[data-project-section="build"]').childNodes[0].textContent = "Build files ";
    $("#save-project-structure").classList.add("hidden");
    $('[data-project-pane="project"]').innerHTML = `<header><h3>${escapeHtml(project.framework)}</h3><p>Generic project model built from the repository's files and folders.</p></header><div class="project-safety-note"><span>✓</span><div><strong>This repository remains fully usable</strong><small>Terminal, Git, search, diffs and AI work do not require a framework-specific analyzer.</small></div></div>`;
    $('[data-project-pane="modules"]').innerHTML = `<header><h3>Project folders</h3><p>Conventional source, test, config and documentation roots.</p></header><div class="java-module-list">${moduleCards(project, "No conventional source roots detected.")}</div>`;
    $('[data-project-pane="sdks"]').innerHTML = `<header><h3>Detected languages</h3><p>Language mix sampled from repository source files.</p></header><div class="node-script-list">${project.runtime.languages.map((language) => `<article><div><strong>${escapeHtml(language.name)}</strong><code>${language.count} source files</code></div></article>`).join("") || `<div class="empty-list">No recognized source files detected.</div>`}</div>`;
    $('[data-project-pane="build"]').innerHTML = `<header><h3>Build files</h3><p>Known build and container files discovered at repository root.</p></header><div class="java-build-details"><dl><div><dt>Detected tool</dt><dd>${escapeHtml(project.build.tool)}</dd></div><div><dt>Files</dt><dd>${project.build.files.length ? project.build.files.map((file) => `<code>${escapeHtml(file)}</code>`).join("") : "No standard build file detected"}</dd></div></dl></div>`;
    $("#project-structure-status").textContent = "Use Terminal or create a Services run configuration for custom commands.";
}
function renderJavaProjectStructure(project) {
    $("#project-type-eyebrow").textContent = "JAVA PROJECT";
    $("#project-structure-subtitle").textContent = `${project.repository.name} · ${project.build.tool}${project.build.version ? ` ${project.build.version}` : ""}`;
    $("#project-platform-label").textContent = "PLATFORM SETTINGS";
    $("#project-runtime-label").textContent = "SDKs";
    $("#project-sdk-count").textContent = project.jdks.length;
    $('[data-project-section="build"]').childNodes[0].textContent = "Build ";
    $("#save-project-structure").classList.remove("hidden");
    $('[data-project-pane="project"]').innerHTML = `<header><h3>Project</h3><p>Repository-wide Java defaults used by Argus run configurations.</p></header><div class="project-form-grid"><label>Project name<input id="java-project-name" value="${escapeHtml(project.repository.name)}" readonly /></label><label>Build system<input id="java-build-system" value="${escapeHtml(`${project.build.tool}${project.build.version ? ` ${project.build.version}` : ""}`)}" readonly /></label><label class="wide">Project SDK<select id="java-project-sdk"><option value="">Automatic · inherit from Argus</option>${project.jdks.map((jdk) => `<option value="${escapeHtml(jdk.path)}">${escapeHtml(`${jdk.name} · ${jdk.version || "version unknown"} · ${jdk.architecture}`)}</option>`).join("")}</select><small>The selected JDK is injected as <code>JAVA_HOME</code> whenever Argus runs this service.</small></label><label>Language level<input value="${escapeHtml(project.languageLevel)}" readonly /></label><label>Compiler output<input value="${escapeHtml(project.compilerOutput)}" readonly /></label></div><div class="project-safety-note"><span>✓</span><div><strong>Local runtime setting</strong><small>Argus does not rewrite Gradle or Maven files.</small></div></div>`;
    $("#java-project-sdk").value = project.settings.javaHome || "";
    $('[data-project-pane="modules"]').innerHTML = `<header><h3>Modules</h3><p>Detected Gradle/Maven modules and their content roots.</p></header><div class="java-module-list">${moduleCards(project, "No conventional Java source roots detected.")}</div>`;
    $('[data-project-pane="sdks"]').innerHTML = `<header><h3>Installed SDKs</h3><p>JDK installations available to Argus on this Mac.</p></header><div class="java-sdk-list">${project.jdks.map((jdk) => `<button type="button" class="java-sdk-card ${jdk.path === project.settings.javaHome ? "selected" : ""}" data-java-home="${escapeHtml(jdk.path)}"><span class="java-sdk-badge">JDK</span><div><strong>${escapeHtml(jdk.name)}</strong><small>${escapeHtml(`${jdk.vendor} · ${jdk.version || "Version unknown"} · ${jdk.architecture}`)}</small><code>${escapeHtml(jdk.path)}</code></div><span class="sdk-selected-indicator">${jdk.path === project.settings.javaHome ? "Selected" : "Use SDK"}</span></button>`).join("") || `<div class="project-empty-warning"><strong>No JDK installation detected</strong><p>Install a JDK or expose it through JAVA_HOME, then refresh this panel.</p></div>`}</div>`;
    $('[data-project-pane="build"]').innerHTML = `<header><h3>Build model</h3><p>Settings derived from repository files.</p></header><div class="java-build-details"><dl><div><dt>Build tool</dt><dd>${escapeHtml(project.build.tool)}</dd></div><div><dt>Version</dt><dd>${escapeHtml(project.build.version || "Managed by system")}</dd></div><div><dt>Language level</dt><dd>${escapeHtml(project.languageLevel)}</dd></div><div><dt>Compiler output</dt><dd><code>${escapeHtml(project.compilerOutput)}</code></dd></div><div><dt>Build files</dt><dd>${project.build.files.length ? project.build.files.map((file) => `<code>${escapeHtml(file)}</code>`).join("") : "None detected"}</dd></div></dl></div>`;
    $("#project-structure-status").textContent = "Changes apply to future starts and restarts.";
}
async function openProjectStructure() {
    if (!state.activeRepository)
        return toast("Open a repository first", "error");
    showAppDialog("project-structure-dialog");
    $("#project-structure-loading").classList.remove("hidden");
    $$('[data-project-pane]').forEach((pane) => pane.classList.add("hidden"));
    $("#project-structure-subtitle").textContent = `${state.activeRepository.name} · detecting local project model…`;
    try {
        renderProjectStructure(await api(`/api/repositories/${state.activeRepository.id}/project-structure`));
    }
    catch (error) {
        $("#project-structure-loading").innerHTML = `<div class="project-empty-warning"><strong>Project structure could not be read</strong><p>${escapeHtml(error.message)}</p></div>`;
    }
}
function cancellationSummary(cancellation) {
    if (!cancellation)
        return "Cancellation caller was not recorded for this run.";
    const controls = {
        "global-composer-stop": "Nexus chat Stop button",
        "global-prompt-edit": "Nexus Save & resend",
        "repository-prompt-edit": "Repository Save & resend",
        "repository-composer-stop": "repository chat Stop button",
        "background-job-stop": "background activity Stop button",
    };
    const causes = {
        job_stop_request: "Agent-job stop API request",
        run_stop_request: "Agent-run stop API request",
        preparation_stop_request: "Request-preparation stop API request",
        application_shutdown: "Argus shutdown",
        repository_removed: "Repository removal",
        run_no_longer_active: "Run was no longer active",
        background_cancel: "Background activity cancellation",
        background_shutdown: "Background activity shutdown",
        internal_stop: "Internal stop",
    };
    const cause = causes[cancellation.cause] || "Stop request";
    const control = controls[cancellation.reportedControl];
    return `${cause}${control ? ` · reported by ${control}` : ""}${cancellation.attribution === "internal" ? "" : " · person not verified"}.`;
}
function cancellationDetail(cancellation) {
    if (!cancellation)
        return "This record predates caller auditing. Resolved PR comments do not establish why it stopped.";
    return [
        cancellation.requestedAt && `Requested: ${cancellation.requestedAt}`,
        cancellation.route && `Server path: ${cancellation.route}`,
        cancellation.id && `Audit ID: ${cancellation.id}`,
        cancellation.jobId && `Job: ${cancellation.jobId}`,
        cancellation.runId && `Run: ${cancellation.runId}`,
        cancellation.preparationId && `Preparation: ${cancellation.preparationId}`,
        cancellation.attribution !== "internal" && "UI labels identify the reported control, not an authenticated person.",
    ].filter(Boolean).join("\n");
}
function mergeCancellationLogs(sessionLogs, cancellations) {
    const retained = cancellations.map((entry) => ({
        id: entry.id, timestamp: entry.requestedAt, category: "cancellation", operation: cancellationSummary(entry),
        status: "cancelled", output: cancellationDetail(entry), persistedCancellation: true,
    }));
    const session = sessionLogs.flatMap((entry) => {
        if (entry.category !== "agents" || entry.operation !== "cancellation")
            return [entry];
        const mirrored = entry.status === "requested" && cancellations.some((audit) => audit.id && String(entry.output).includes(audit.id));
        return mirrored ? [] : [{ ...entry, category: "cancellation" }];
    });
    return [...retained, ...session]
        .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
}
async function saveProjectStructure() {
    const button = $("#save-project-structure");
    button.disabled = true;
    button.textContent = "Applying…";
    try {
        renderProjectStructure(await api(`/api/repositories/${state.activeRepository.id}/java-project`, { method: "PUT", body: { javaHome: $("#java-project-sdk").value, languageLevel: "project" } }));
        toast("Project SDK saved locally");
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        button.disabled = false;
        button.textContent = "Apply";
    }
}
async function loadWorkspaceSnapshot() {
    const layoutRevision = state.repositoryTabLayoutRevision || 0;
    const runtimeRevision = runtimeStateSync?.revision;
    const knownRepositoryIds = new Set((state.workspace?.repositories || []).map((repository) => String(repository.id)));
    let snapshot = await api("/api/workspace", { dedupe: false, cache: "no-store" });
    if (runtimeRevision !== runtimeStateSync?.revision && state.workspace)
        snapshot = { ...snapshot, repositories: state.workspace.repositories, runConfigurations: state.workspace.runConfigurations };
    if (layoutRevision === (state.repositoryTabLayoutRevision || 0))
        return snapshot;
    const repositories = snapshot.repositories || [];
    const latest = state.workspace?.preferences || {};
    const savedGroups = normalizeRepositoryTabGroups(latest.repositoryTabGroups, repositories);
    const addedGroups = normalizeRepositoryTabGroups(snapshot.preferences?.repositoryTabGroups, repositories)
        .map((group) => ({ ...group, repositoryIds: group.repositoryIds.filter((id) => !knownRepositoryIds.has(id)) }))
        .filter((group) => group.repositoryIds.length);
    const savedGroupIds = new Set(savedGroups.map((group) => group.id));
    const groups = normalizeRepositoryTabGroups([
        ...savedGroups.map((group) => ({ ...group, repositoryIds: [...group.repositoryIds, ...(addedGroups.find((added) => added.id === group.id)?.repositoryIds || [])] })),
        ...addedGroups.filter((group) => !savedGroupIds.has(group.id)),
    ], repositories);
    return { ...snapshot, preferences: { ...(snapshot.preferences || {}), repositoryTabGroups: groups,
            repositoryTabOrder: normalizeRepositoryTabOrder(latest.repositoryTabOrder, repositories, groups) } };
}
async function initialize() {
    try {
        aiContextHeader ||= createAiContextHeader({ document, window });
        const providerRequest = api("/api/agents/providers").catch(() => []);
        state.workspace = await loadWorkspaceSnapshot();
        applyTheme(localStorage.getItem("argus-theme") || state.workspace.preferences?.theme || "dark", false);
        nexusThemePicker.restore(state.workspace.preferences?.nexusThemes ?? state.workspace.preferences?.nexusTheme);
        fontFamilyPicker.restore(state.workspace.preferences?.fontFamily);
        applyFontSize(localStorage.getItem("argus-font-size") || state.workspace.preferences?.fontSize || "comfortable", false);
        const routeRepositoryId = window.location.pathname.match(/^\/repositories\/([^/]+)(?:\/tasks\/[^/]+)?\/?$/)?.[1];
        state.activeRepository = state.workspace.repositories.find((repo) => repo.id === decodeURIComponent(routeRepositoryId || "")) || state.workspace.repositories.find((repo) => repo.id === state.workspace.activeRepositoryId) || null;
        renderRepositoryTabs({ revealActive: true });
        renderProviderOptions();
        const openingPlanner = pendingPlannerOpen || /^\/daily-tasks\/?$/.test(window.location.pathname);
        const openingRepository = !openingPlanner && (/^\/$/.test(window.location.pathname)
            || /^\/repositories\//.test(window.location.pathname));
        if (state.activeRepository) {
            syncRepositoryWorkspacePresence();
            restoreScopedComposer("repository");
            if (openingRepository)
                await refreshActiveRepository();
        }
        else {
            syncRepositoryWorkspacePresence();
        }
        state.navigationReady = true;
        if (pendingPlannerOpen) {
            pendingPlannerOpen = false;
            window.history.replaceState({ view: "daily-planner" }, "", "/daily-tasks");
        }
        await restoreRoute();
        if (!openingRepository && state.activeRepository)
            void refreshActiveRepository();
        Promise.allSettled([refreshApiClientData(false), refreshProcesses(false)]);
        providerRequest.then((providers) => { providerStatusPoller.invalidate(); state.providers = providers; renderProviderOptions(); });
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function renderProviderOptions() {
    const options = state.providers.map((provider) => `<option value="${provider.id}" ${providerCanRun(provider) ? "" : "disabled"}>${escapeHtml(provider.name)}${providerOptionSuffix(provider)}</option>`).join("");
    $("#agent-provider").innerHTML = options;
    $("#global-agent-provider").innerHTML = options;
    const runnable = state.providers.filter(providerCanRun);
    const verifiedReady = state.providers.filter(providerIsVerifiedReady);
    $("#run-agent").disabled = !runnable.length;
    const blocked = state.providers.filter((provider) => provider.authenticated && !providerCanRun(provider));
    $("#ai-status-text").textContent = verifiedReady.length ? `${verifiedReady.map((provider) => provider.name).join(" + ")} ready` : runnable.length ? "AI connected · usage unverified" : blocked.length ? "AI usage unavailable" : "AI sign-in required";
    $("#ai-status-pill").querySelector(".status-dot").style.background = verifiedReady.length ? "var(--green)" : runnable.length || blocked.length ? "var(--orange)" : "var(--red)";
    $("#ai-status-pill").title = state.providers.map(providerStatusDescription).join("\n");
    $("#run-global-agent").disabled = !runnable.length;
    renderModelControls("repository");
    renderModelControls("global");
    updateProviderContextControls("repository");
    updateProviderContextControls("global");
    renderAIConnections();
    updateLocalAIInfo();
    updateGlobalAIInfo();
}
function providerStatusDescription(provider) {
    if (!provider?.installed)
        return `${provider?.name || "AI provider"}: not installed`;
    if (!provider.authenticated)
        return `${provider.name}: sign-in required`;
    const availability = providerAvailability(provider);
    const reset = availability.resetHint ? ` · ${availability.resetHint}` : "";
    return `${provider.name}: ${availability.message || availability.status}${reset}`;
}
function providerBlockedMessage(provider) {
    const availability = providerAvailability(provider);
    if (availability.status === "exhausted")
        return `${provider.name} usage quota has been reached${availability.resetHint ? `; resets ${availability.resetHint}` : ""}. Switch provider or try again after reset.`;
    if (availability.status === "rate-limited")
        return `${provider.name} is temporarily rate limited${availability.resetHint ? `; try again ${availability.resetHint}` : ""}.`;
    return `${provider?.name || "AI provider"} is not currently available`;
}
function modelControlElements(scope) {
    const prefix = scope === "global" ? "global-agent" : "agent";
    return {
        provider: $(`#${prefix}-provider`),
        model: $(`#${prefix}-model`),
        effort: $(`#${prefix}-effort`),
        speed: $(`#${prefix}-speed`),
    };
}
function currentModelSelectionKey(scope) {
    return modelSelectionKey(scope, state.activeRepository?.id, activeTaskId(scope));
}
function scopedModelSelection(scope) {
    const saved = modelSelections.get(currentModelSelectionKey(scope));
    if (saved)
        return saved;
    const task = taskList(scope).find((item) => item.id === activeTaskId(scope));
    return task || {};
}
function modelOptionsMarkup(selection) {
    let options = selection.catalog.map((model) => `<option value="${escapeHtml(model.id)}" title="${escapeHtml(modelIdentityDescription(model))}">${escapeHtml(model.displayName || model.id)}</option>`).join("");
    if (!selection.selected && selection.model)
        options += `<option value="${escapeHtml(selection.model)}">${escapeHtml(selection.model)} · unavailable</option>`;
    return options || '<option value="">No models available</option>';
}
function effortOptionsMarkup(selection) {
    let options = selection.efforts.map((entry) => `<option value="${escapeHtml(entry.effort)}" title="${escapeHtml(entry.description || "")}">${escapeHtml(reasoningLabel(entry.effort))}</option>`).join("");
    if (selection.effort && selection.effort !== "auto" && !selection.efforts.some((entry) => entry.effort === selection.effort))
        options += `<option value="${escapeHtml(selection.effort)}">${escapeHtml(reasoningLabel(selection.effort))} · unavailable</option>`;
    return options || '<option value="auto">Not supported</option>';
}
function renderModelControls(scope, requested) {
    const controls = modelControlElements(scope);
    const saved = requested || scopedModelSelection(scope);
    const providerId = saved.provider || state.providers.find(providerCanRun)?.id || state.providers[0]?.id || "";
    if (providerId && ![...controls.provider.options].some((option) => option.value === providerId)) {
        controls.provider.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(providerId)}">${escapeHtml(providerId)} · unavailable</option>`);
    }
    controls.provider.value = providerId;
    const providerDetails = state.providers.find((item) => item.id === providerId);
    const selection = resolveModelSelection(providerDetails, { ...saved, provider: providerId });
    controls.model.innerHTML = modelOptionsMarkup(selection);
    controls.model.value = selection.model;
    controls.model.title = modelIdentityDescription(selection.selected) || selection.error;
    const identity = $(`#${scope === "global" ? "global-agent" : "agent"}-model-identity`);
    if (identity) {
        const resolved = selection.selected?.resolvedModel;
        identity.textContent = resolved && resolved !== selection.model ? `${selection.model} → ${resolved}` : "";
        identity.hidden = !identity.textContent;
    }
    const catalogSource = $(`#${scope === "global" ? "global-agent" : "agent"}-catalog-source`);
    if (catalogSource) {
        const status = modelCatalogStatus(providerDetails);
        catalogSource.textContent = status.text;
        catalogSource.title = status.title;
    }
    controls.effort.innerHTML = effortOptionsMarkup(selection);
    controls.effort.value = selection.effort;
    controls.effort.title = selection.efforts.find((entry) => entry.effort === selection.effort)?.description || selection.error;
    const speedControl = modelSpeedControl(selection);
    controls.speed.innerHTML = speedControl.options.map((item) => `<option value="${item.value}"${item.disabled ? " disabled" : ""}>${item.label}</option>`).join("");
    controls.speed.value = selection.speed;
    controls.effort.disabled = !selection.efforts.length && selection.effort === "auto";
    controls.effort.closest("label")?.classList.toggle("hidden", controls.effort.disabled);
    controls.speed.disabled = speedControl.disabled;
    controls.speed.title = speedControl.title;
    const speedLabel = controls.speed.closest("label");
    if (speedLabel) {
        speedLabel.title = speedControl.title;
        speedLabel.classList.toggle("speed-unavailable", speedControl.unavailable);
    }
    renderModelConfigurationSummary(scope);
    if (providerDetails && selection.model && !selection.error && !modelSelections.get(currentModelSelectionKey(scope)))
        modelSelections.set(currentModelSelectionKey(scope), selection);
    setComposerActionState(scope, Boolean(runningAgentJob(scope)));
}
function modelSelectionError(scope) {
    return resolveModelSelection(selectedProvider(scope), selectedModelSettings(scope)).error;
}
function persistModelSelection(scope) {
    const settings = { provider: modelControlElements(scope).provider.value, ...selectedModelSettings(scope) };
    const key = currentModelSelectionKey(scope);
    const taskId = activeTaskId(scope);
    modelSelections.set(key, settings);
    if (scope === "repository")
        modelSelections.set(modelSelectionKey(scope, state.activeRepository?.id, null), settings);
    if (!taskId || modelSelectionError(scope))
        return;
    syncTaskModelSelection(taskId, settings);
}
function syncTaskModelSelection(taskId, settings) {
    const pending = (modelSelectionWrites.get(taskId) || Promise.resolve()).catch(() => { }).then(() => api(`/api/ai-tasks/${taskId}/model-settings`, { method: "PATCH", body: settings }));
    modelSelectionWrites.set(taskId, pending);
    return pending.catch((error) => toast(`Model selection is saved on this device; could not sync this chat: ${error.message}`, "error"));
}
async function retainStartedTaskSelection(scope, taskId, submission, submittedSettings) {
    if (!taskId)
        return;
    const taskKey = modelSelectionKey(scope, submission.repositoryId, taskId);
    const sameDraft = !submission.taskId && (modelDraftEpochs.get(submission.modelSelectionKey) || 0) === submission.modelDraftEpoch;
    const latestDraft = sameDraft ? modelSelections.get(submission.modelSelectionKey) : null;
    const settings = modelSelections.get(taskKey) || latestDraft || submittedSettings;
    modelSelections.set(taskKey, settings);
    if (!submission.taskId && !chatContextPreference.has(taskKey)) {
        chatContextPreference.set(taskKey, sameDraft ? chatContextPreference.get(submission.modelSelectionKey) : submission.contextMode === "fresh" ? "fresh" : "history");
    }
    if (!submission.taskId && JSON.stringify(settings) !== JSON.stringify(submittedSettings))
        await syncTaskModelSelection(taskId, settings);
}
function renderModelConfigurationSummary(scope) {
    const prefix = scope === "global" ? "global-agent" : "agent";
    const effort = reasoningLabel($(`#${prefix}-effort`)?.value);
    const mode = $(`#${prefix}-mode`)?.value === "edit" ? "Edit" : "Plan";
    const speed = $(`#${prefix}-speed`)?.value === "fast" ? "Fast" : "";
    const summary = $(`#${prefix}-config-summary`);
    const error = modelSelectionError(scope);
    if (summary) {
        summary.textContent = error ? "Selection unavailable" : [$(`#${prefix}-effort`)?.disabled ? "" : effort, speed, mode].filter(Boolean).join(" · ");
        summary.closest("summary").title = error || `Reasoning: ${effort}. Speed: ${speed || "standard"}. Access: ${mode}.`;
    }
    const message = $(`#${prefix}-model-error`);
    if (message) {
        message.textContent = error;
        message.classList.toggle("hidden", !error);
    }
}
function resizeAgentComposer(textarea) {
    if (!textarea)
        return;
    const geometry = getComputedStyle(textarea);
    const minimum = Number.parseFloat(geometry.minHeight) || 68;
    const maximum = Math.max(minimum, Number.parseFloat(geometry.maxHeight) || 150);
    textarea.style.height = `${minimum}px`;
    textarea.style.height = `${Math.min(maximum, Math.max(minimum, textarea.scrollHeight))}px`;
}
function selectedModelSettings(scope) {
    const controls = modelControlElements(scope);
    return { model: controls.model.value, effort: controls.effort.value, speed: controls.speed.value };
}
function selectedContextMode(scope) {
    const control = scope === "global" ? $("#global-agent-context-mode") : $("#agent-context-mode");
    return control?.value === "fresh" ? "fresh" : "history";
}
function restoreContextMode(scope, task) {
    const control = scope === "global" ? $("#global-agent-context-mode") : $("#agent-context-mode");
    if (control)
        control.value = chatContextPreference.get(currentModelSelectionKey(scope), task);
    renderContextMode(scope);
}
function persistContextMode(scope) {
    chatContextPreference.set(currentModelSelectionKey(scope), selectedContextMode(scope));
    renderContextMode(scope);
}
function renderContextMode(scope) {
    const history = selectedContextMode(scope) === "history";
    const global = scope === "global";
    const composer = global ? $(".global-prompt-card.chat-composer") : $(".prompt-card.chat-composer");
    composer?.classList.toggle("history-context-mode", history);
    composer?.dispatchEvent(new Event("change", { bubbles: true }));
    renderModelConfigurationSummary(scope);
}
function restoreTaskModelSettings(scope, task) {
    renderModelControls(scope, modelSelections.get(currentModelSelectionKey(scope)) || task);
    restoreContextMode(scope, task);
    renderModelConfigurationSummary(scope);
    if (scope === "global")
        updateGlobalAIInfo();
    else
        updateLocalAIInfo();
}
function handleProviderChange(scope) {
    renderModelControls(scope, { provider: modelControlElements(scope).provider.value });
    persistModelSelection(scope);
    updateProviderContextControls(scope);
    if (scope === "global")
        updateGlobalAIInfo();
    else
        updateLocalAIInfo();
    if (scopedAttachments(scope).length)
        validateComposerContext(scope);
}
function handleModelChange(scope) {
    const controls = modelControlElements(scope);
    const provider = selectedProvider(scope);
    const model = providerModelCatalog(provider).find((item) => item.id === controls.model.value);
    const supported = model?.supportedReasoningEfforts || [];
    const effort = supported.some((item) => (item.effort || item) === controls.effort.value) ? controls.effort.value : "";
    const speed = (model?.supportsFastMode ?? provider?.supportsFastMode) ? controls.speed.value : "standard";
    renderModelControls(scope, { provider: controls.provider.value, model: controls.model.value, effort, speed });
    persistModelSelection(scope);
}
function handleSpeedChange(scope) {
    renderModelConfigurationSummary(scope);
    persistModelSelection(scope);
    setComposerActionState(scope, Boolean(runningAgentJob(scope)));
}
function updateGlobalAIInfo() {
    const provider = state.providers.find((item) => item.id === $("#global-agent-provider").value);
    const connected = providerCanRun(provider);
    const repositoryCount = state.workspace?.repositories?.length || 0;
    const accessMode = "Can edit + use Git";
    $("#global-ai-status").textContent = provider ? `${provider.name} ${connected ? "connected" : provider.authenticated ? "usage unavailable" : "not connected"}` : "AI connection required";
    $("#global-ai-version").textContent = connected ? `${provider.version || "CLI detected"} · ${providerAvailability(provider).message}` : provider?.authenticated ? providerStatusDescription(provider) : provider?.installed ? "sign-in required" : "not installed";
    $("#global-ai-repository-scope").textContent = repositoryCount ? `${repositoryCount} connected repositor${repositoryCount === 1 ? "y" : "ies"}` : "No connected repositories";
    $("#global-ai-access-mode").textContent = accessMode;
    $("#global-ai-access-mode").classList.add("edit");
    $("#global-ai-status").closest(".global-ai-info").querySelector(".status-dot").style.background = connected ? "var(--green)" : "var(--red)";
    $("#global-ai-status").closest(".global-ai-info").classList.toggle("disconnected", !connected);
    setComposerActionState("global", Boolean(runningAgentJob("global")));
}
function cliCapabilityScopeKey(providerId) {
    return `${providerId}:${state.activeRepository?.id || "global"}`;
}
async function refreshCliCapabilities(providerId, refresh = false) {
    const repositoryId = state.activeRepository?.id || "";
    const key = cliCapabilityScopeKey(providerId);
    if (state.cliCapabilityRequests.has(key))
        return state.cliCapabilityRequests.get(key);
    if (!refresh && state.cliCapabilityReports.has(key))
        return state.cliCapabilityReports.get(key);
    const query = new URLSearchParams({ refresh: String(refresh), ...(repositoryId ? { repositoryId } : {}) });
    const request = api(`/api/agents/capabilities/${encodeURIComponent(providerId)}?${query}`, { timeout: 18000 })
        .then((report) => state.cliCapabilityReports.set(key, report))
        .catch(() => state.cliCapabilityReports.set(key, { status: "unavailable", integrations: [], limitations: ["Discovery did not complete. Link requests still let the CLI check its own tools."] }))
        .finally(() => { state.cliCapabilityRequests.delete(key); renderAIConnections(); });
    state.cliCapabilityRequests.set(key, request);
    return request;
}
function cliCapabilityDescription(provider) {
    const report = state.cliCapabilityReports.get(cliCapabilityScopeKey(provider.id));
    if (!provider.installed)
        return "CLI not installed";
    if (!report)
        return "Checking configured CLI tools…";
    const available = (report.integrations || []).filter((item) => item.status === "available");
    const labels = available.slice(0, 6).map((item) => item.name || item.id);
    const summary = labels.length ? `Tools exposed: ${labels.join(", ")}${available.length > 6 ? ` +${available.length - 6}` : ""}` : report.status === "unavailable" ? "Tool discovery unavailable" : "No external tools verified";
    const unavailable = (report.integrations || []).filter((item) => ["needs-auth", "disabled"].includes(item.status)).slice(0, 4).map((item) => `${item.name || item.id}: ${item.status === "needs-auth" ? "sign-in required" : "disabled"}`);
    return `${summary}${unavailable.length ? `. ${unavailable.join("; ")}` : ""}. Access to each link is checked when used.`;
}
function renderAIConnections() {
    const target = $("#ai-connection-list");
    if (!target)
        return;
    if (!state.providers.length) {
        target.innerHTML = `<div class="ai-connections-empty"><strong>No provider status loaded yet</strong><small>Argus is loading saved provider information. You can close this window and keep working.</small></div>`;
        return;
    }
    target.innerHTML = state.providers.map((provider) => {
        const refreshing = state.refreshingAiProviders.has(provider.id);
        const runnable = providerCanRun(provider);
        const verifiedReady = providerIsVerifiedReady(provider);
        const availability = providerAvailability(provider);
        const status = providerConnectionStatus(provider, refreshing);
        const source = provider.authMethod || provider.apiProvider || "Not reported";
        const mark = (provider.name?.trim()?.[0] || "C").toUpperCase();
        const actions = `<div class="ai-provider-card-actions"><button type="button" data-refresh-ai-provider="${escapeHtml(provider.id)}" title="Detect and check this CLI now" ${refreshing ? "disabled" : ""}><span class="refresh-glyph ${refreshing ? "loading" : ""}">↻</span></button></div>`;
        const setupUrl = provider.id === "codex" ? "https://learn.chatgpt.com/docs/codex/cli" : provider.id === "claude" ? "https://code.claude.com/docs/en/setup" : "";
        const setupGuide = (!provider.installed || !provider.authenticated) && setupUrl ? `<div class="ai-provider-setup"><strong>${provider.installed ? "Complete CLI sign-in" : "Connect your coding CLI"}</strong><p>${provider.installed ? "Open the CLI in Terminal and finish sign-in with your own account." : "Install this provider’s CLI using its official setup guide, then open it in Terminal and complete sign-in."} Return here and refresh. If you installed a new tool location while Argus was open, restart Argus first.</p><a href="${setupUrl}" target="_blank" rel="noopener noreferrer">Open official setup guide ↗</a><small>No credentials are requested here. You can browse repositories and use Git without AI.</small></div>` : "";
        return `<article class="ai-connection-card ${verifiedReady ? "connected" : ""} ${runnable && !verifiedReady ? "unverified" : ""} ${provider.authenticated && !runnable ? "usage-blocked" : ""} ${refreshing ? "refreshing" : ""}">
      <header><div class="ai-provider-mark">${mark}</div><div><h3>${escapeHtml(provider.name)}</h3><span class="ai-connection-state"><i></i>${escapeHtml(status)}</span></div>${actions}</header>
      <dl>
        <div><dt>Runtime</dt><dd>${escapeHtml(provider.version || "Not detected")}</dd></div>
        <div><dt>Executable</dt><dd title="${escapeHtml(provider.executablePath || "")}">${escapeHtml(provider.executablePath || "Not detected")}</dd></div>
        <div><dt>Authentication</dt><dd>${escapeHtml(source)}</dd></div>
        <div><dt>Models</dt><dd>${escapeHtml(String(provider.models?.length || 0))} configured · ${escapeHtml(provider.defaultModel || "provider default")}</dd></div>
        <div><dt>Usage availability</dt><dd class="${verifiedReady ? "available" : "unavailable"}" title="${escapeHtml(providerAvailabilitySource(provider))}">${escapeHtml(availability.message)}${availability.resetHint ? ` · ${escapeHtml(availability.resetHint)}` : ""}${availability.checkedAt ? ` · checked ${escapeHtml(formatExecutionTimestamp(availability.checkedAt))}` : ""}</dd></div>
        <div><dt>Credential handling</dt><dd>Managed by ${escapeHtml(provider.name)} CLI</dd></div>
        <div><dt>Repository access</dt><dd>Selected task scope only</dd></div>
        <div><dt>CLI apps & browser tools</dt><dd>${escapeHtml(cliCapabilityDescription(provider))}</dd></div>
        <div><dt>Chrome extension</dt><dd>Shared page snapshot only · live interaction requires a CLI browser tool</dd></div>
      </dl>
      ${setupGuide}
    </article>`;
    }).join("");
    if ($("#ai-connections-dialog")?.open) {
        for (const provider of state.providers.filter((item) => item.installed))
            void refreshCliCapabilities(provider.id);
    }
}
async function refreshConfiguredAiProvider(providerId) {
    if (state.refreshingAiProviders.has(providerId))
        return;
    providerStatusPoller.invalidate();
    state.refreshingAiProviders.add(providerId);
    renderAIConnections();
    try {
        const provider = await api(`/api/agents/providers/${encodeURIComponent(providerId)}/refresh`, { method: "POST", timeout: 25000 });
        updateProviderState(provider);
        await refreshCliCapabilities(providerId, true);
        toast(`${provider.name} status refreshed`);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        state.refreshingAiProviders.delete(providerId);
        renderProviderOptions();
    }
}
async function refreshBrowserPairingStatus({ silent = false } = {}) {
    try {
        const status = await api("/api/browser-extension/status");
        $("#browser-pairing-dot").classList.toggle("paired", status.paired);
        $("#browser-pairing-status").textContent = status.paired
            ? "Securely paired on this Mac"
            : status.pairingPending ? "Waiting for the extension to enter the code" : "Not paired";
        $("#start-browser-pairing").textContent = status.paired ? "Pair another browser" : "Pair extension";
        if (status.paired && !$("#browser-pairing-code").classList.contains("hidden")) {
            $("#browser-pairing-code").classList.add("hidden");
            clearInterval(state.browserPairingTimer);
            state.browserPairingTimer = null;
            if (!silent)
                toast("Chrome extension paired securely");
        }
        return status;
    }
    catch (error) {
        $("#browser-pairing-status").textContent = "Pairing status unavailable";
        if (!silent)
            toast(error.message, "error");
        return null;
    }
}
async function startBrowserPairing() {
    const button = $("#start-browser-pairing");
    button.disabled = true;
    try {
        const pairing = await api("/api/browser-extension/pair/start", { method: "POST" });
        $("#browser-pairing-code").classList.remove("hidden");
        $("#browser-pairing-code code").textContent = pairing.code;
        $("#browser-pairing-status").textContent = "Enter this code in the Argus Chrome extension";
        clearInterval(state.browserPairingTimer);
        state.browserPairingTimer = setInterval(() => refreshBrowserPairingStatus({ silent: true }), 1500);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        button.disabled = false;
    }
}
async function refreshAIConnections() {
    if (state.aiConnectionsRefreshPromise)
        return state.aiConnectionsRefreshPromise;
    providerStatusPoller.invalidate();
    const button = $("#refresh-ai-connections");
    setRefreshLoading(button, true);
    state.aiConnectionsRefreshPromise = (async () => {
        try {
            if (!state.providers.length) {
                state.providers = await api("/api/agents/providers", { timeout: 10000 });
                providerStatusPoller.invalidate();
                renderProviderOptions();
            }
            const providerIds = state.providers.map((provider) => provider.id);
            providerIds.forEach((id) => state.refreshingAiProviders.add(id));
            renderAIConnections();
            const refreshes = await Promise.allSettled(providerIds.map(async (providerId) => {
                try {
                    const provider = await api(`/api/agents/providers/${encodeURIComponent(providerId)}/refresh`, { method: "POST", timeout: 25000 });
                    updateProviderState(provider);
                    await refreshCliCapabilities(providerId, true);
                    return provider;
                }
                finally {
                    state.refreshingAiProviders.delete(providerId);
                    renderProviderOptions();
                }
            }));
            const failed = refreshes.filter((result) => result.status === "rejected").length;
            toast(failed ? `AI status checked · ${failed} provider${failed === 1 ? "" : "s"} did not respond in time` : "AI connection status refreshed", failed ? "error" : undefined);
        }
        catch (error) {
            toast(error.message, "error");
        }
        finally {
            state.refreshingAiProviders.clear();
            state.aiConnectionsRefreshPromise = null;
            setRefreshLoading(button, false);
            renderProviderOptions();
        }
    })();
    return state.aiConnectionsRefreshPromise;
}
function updateProviderState(provider) {
    providerStatusPoller.invalidate();
    const index = state.providers.findIndex((item) => item.id === provider.id);
    if (index >= 0)
        state.providers.splice(index, 1, provider);
    else
        state.providers.push(provider);
}
function updateLocalAIInfo() {
    const selected = state.providers.find((provider) => provider.id === $("#agent-provider").value) || state.providers[0];
    $("#local-ai-provider").textContent = selected ? `${selected.name}${providerCanRun(selected) ? " authenticated" : selected.authenticated ? " usage unavailable" : selected.installed ? " needs sign-in" : " unavailable"}` : "No AI connected";
    $("#local-ai-version").textContent = selected?.authenticated ? `${selected.version}${selected.authMethod ? ` · ${selected.authMethod}` : ""} · ${providerAvailability(selected).message}` : selected?.version || "CLI not detected";
    $("#local-ai-repository").textContent = state.activeRepository?.path || "No active repository";
    $("#local-ai-access").textContent = $("#agent-mode").value === "plan" ? "Read-only investigation" : "Can edit and use Git";
    aiContextHeader?.update({
        providerName: selected?.name || "No AI", status: providerConnectionStatus(selected),
        readiness: providerIsVerifiedReady(selected) ? "ready" : selected?.authenticated ? "warning" : "off",
        repositoryName: state.activeRepository?.name || "Repository AI", mode: $("#agent-mode").value,
    });
    setComposerActionState("repository", Boolean(runningAgentJob("repository")));
}
function repositoryTabGroups() {
    const groups = normalizeRepositoryTabGroups(state.workspace?.preferences?.repositoryTabGroups, state.workspace?.repositories || []);
    if (state.workspace?.preferences)
        state.workspace.preferences.repositoryTabGroups = groups;
    return groups;
}
async function persistRepositoryTabGroups(groups) {
    return persistRepositoryTabLayout(groups);
}
async function persistRepositoryTabLayout(groups, order) {
    if (state.repositoryTabSaving)
        throw new Error("Tab layout is being saved. Please try again in a moment.");
    const previousGroups = repositoryTabGroups();
    const normalized = normalizeRepositoryTabGroups(groups, state.workspace.repositories);
    const normalizedOrder = order === undefined
        ? reconcileRepositoryTabOrder(state.workspace.preferences?.repositoryTabOrder, state.workspace.repositories, previousGroups, normalized)
        : normalizeRepositoryTabOrder(order, state.workspace.repositories, normalized);
    state.repositoryTabSaving = true;
    $("#repo-tabs").setAttribute("aria-busy", "true");
    try {
        await api("/api/preferences", { method: "PATCH", body: { repositoryTabGroups: normalized, repositoryTabOrder: normalizedOrder } });
        state.workspace.preferences = { ...(state.workspace.preferences || {}), repositoryTabGroups: normalized, repositoryTabOrder: normalizedOrder };
        state.repositoryTabLayoutRevision = (state.repositoryTabLayoutRevision || 0) + 1;
        renderRepositoryTabs();
    }
    finally {
        state.repositoryTabSaving = false;
        $("#repo-tabs").setAttribute("aria-busy", "false");
    }
}
async function moveRepositoryTab(move) {
    if (!state.workspace || state.repositoryTabSaving)
        return;
    const result = reorderRepositoryTabs(state.workspace.repositories, repositoryTabGroups(), state.workspace.preferences?.repositoryTabOrder, move);
    if (!result.changed)
        return;
    const status = $("#repository-tab-move-status");
    if (status)
        status.textContent = "Saving tab layout…";
    try {
        await persistRepositoryTabLayout(result.groups, result.order);
        if (status)
            status.textContent = "Tab layout saved.";
    }
    catch (error) {
        if (status)
            status.textContent = "Tab layout could not be saved. Your previous order is unchanged.";
        toast(error.message, "error");
    }
}
function repositoryTabHtml(repository, group = null) {
    const active = isRepositoryDestination(repository.id);
    return `<div class="repo-tab ${active ? "active" : ""} ${group ? `repo-tab-grouped repo-tab-group-${group.color}` : ""}" data-repository-tab="${escapeHtml(repository.id)}"${group ? ` data-tab-group="${escapeHtml(group.id)}"` : ""} title="${escapeHtml(repository.name)} · ${escapeHtml(repository.path)}${group ? ` · ${escapeHtml(group.name)}` : ""} · Drag to reorder · Alt+Shift+Arrow to move · Right-click to group">
    <button type="button" class="repo-tab-main" data-repository-id="${escapeHtml(repository.id)}"${active ? ' aria-current="page"' : ""}><span class="repo-dot" aria-hidden="true"></span><span class="repo-tab-label">${escapeHtml(repository.name)}</span></button>
    <button type="button" class="repo-tab-close" data-close-repository="${escapeHtml(repository.id)}" aria-label="Offboard ${escapeHtml(repository.name)}" title="Offboard repository">×</button>
  </div>`;
}
function repositoryTabGroupHtml(group) {
    const containsActive = group.repositoryIds.some(isRepositoryDestination);
    return `<button type="button" class="repo-tab-group-chip repo-tab-group-${group.color}${containsActive ? " contains-active" : ""}" data-tab-group="${escapeHtml(group.id)}" data-toggle-tab-group="${escapeHtml(group.id)}" aria-expanded="${!group.collapsed}" aria-label="${group.collapsed ? "Expand" : "Collapse"} ${escapeHtml(group.name)} tab group (${group.repositoryIds.length} repositories)" title="${group.collapsed ? "Expand" : "Collapse"} ${escapeHtml(group.name)} · ${group.repositoryIds.length} repositories · Drag to move the whole group · Alt+Shift+Arrow to move · Right-click to edit group"><span class="repo-tab-group-name">${escapeHtml(group.name)}</span><small aria-hidden="true">${group.repositoryIds.length}</small></button>`;
}
function renderRepositoryTabs({ revealActive = false } = {}) {
    if (state.repositoryTabDrag?.isDragging()) {
        state.repositoryTabRenderPending = true;
        return;
    }
    const groups = repositoryTabGroups();
    const tabs = $("#repo-tabs");
    const scrollLeft = tabs.scrollLeft;
    const focusedRepository = document.activeElement?.closest?.("[data-repository-tab]")?.dataset.repositoryTab;
    const focusedClose = Boolean(document.activeElement?.matches?.("[data-close-repository]"));
    const focusedGroup = tabs.contains(document.activeElement) ? document.activeElement?.closest?.("[data-toggle-tab-group]")?.dataset.toggleTabGroup : null;
    $("#repo-tabs").innerHTML = repositoryTabLayout(state.workspace.repositories, groups, state.workspace.preferences?.repositoryTabOrder).map((item) => {
        if (item.type === "repository")
            return repositoryTabHtml(item.repository);
        return `<div class="repo-tab-group-block repo-tab-group-${item.group.color}${item.group.collapsed ? " is-collapsed" : ""}" data-tab-group-block="${escapeHtml(item.group.id)}" role="group" aria-label="${escapeHtml(item.group.name)} repository tabs">${repositoryTabGroupHtml(item.group)}${item.group.collapsed ? "" : item.repositories.map((repository) => repositoryTabHtml(repository, item.group)).join("")}</div>`;
    }).join("") || `<span class="repository-tabs-empty">Connect your first repository in Tab tools</span>`;
    tabs.scrollLeft = scrollLeft;
    if (focusedRepository) {
        const replacement = [...tabs.querySelectorAll(focusedClose ? "[data-close-repository]" : "[data-repository-id]")].find((button) => (focusedClose ? button.dataset.closeRepository : button.dataset.repositoryId) === focusedRepository);
        (replacement || $("#repository-tab-tools-toggle")).focus({ preventScroll: true });
    }
    else if (focusedGroup) {
        [...tabs.querySelectorAll("[data-toggle-tab-group]")].find((button) => button.dataset.toggleTabGroup === focusedGroup)?.focus({ preventScroll: true });
    }
    renderRepositoryTabTools();
    if (typeof repositoryTabSearch !== "undefined")
        repositoryTabSearch?.refresh();
    if ($("#manage-repositories-dialog").open)
        renderRepositoryManager();
    $("#global-repository-list").innerHTML = state.workspace.repositories.map((repository) => `<div class="global-repository-item" title="${escapeHtml(repository.path)}"><span></span><strong>${escapeHtml(repository.name)}</strong></div>`).join("") || `<div class="empty-list">No services connected.</div>`;
    $("#repo-offboard").disabled = !state.workspace.repositories.length;
    requestAnimationFrame(() => {
        updateRepositoryTabOverflow();
        if (revealActive)
            revealActiveRepositoryTab();
    });
}
function renderRepositoryTabTools() {
    const container = $("#repository-tab-tools-groups");
    const focusedGroup = container.contains(document.activeElement) ? document.activeElement.closest("[data-toggle-tab-group], [data-edit-tab-group]") : null;
    const focusId = focusedGroup?.dataset.toggleTabGroup || focusedGroup?.dataset.editTabGroup;
    const focusSelector = focusedGroup?.dataset.toggleTabGroup ? "[data-toggle-tab-group]" : "[data-edit-tab-group]";
    const orderedGroups = repositoryTabLayout(state.workspace.repositories, repositoryTabGroups(), state.workspace.preferences?.repositoryTabOrder).filter((item) => item.type === "group").map((item) => item.group);
    container.innerHTML = orderedGroups.map((group) => `<div class="repository-tab-tools-group repo-tab-group-${group.color}">
    <button type="button" class="repository-tab-tools-group-toggle" data-toggle-tab-group="${escapeHtml(group.id)}" aria-expanded="${!group.collapsed}" title="${group.collapsed ? "Show" : "Hide"} ${escapeHtml(group.name)} tabs"><span class="repo-dot" aria-hidden="true"></span><span>${escapeHtml(group.name)}</span><small>${group.repositoryIds.length}</small><svg class="disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"></path></svg></button>
    <button type="button" class="repository-tab-tools-group-edit" data-edit-tab-group="${escapeHtml(group.id)}" aria-label="Edit ${escapeHtml(group.name)} tab group" title="Edit tab group"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 5 4 4M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15Z"/></svg></button>
  </div>`).join("") || `<p class="repository-tab-tools-empty">No tab groups yet</p>`;
    if (focusId)
        [...container.querySelectorAll(focusSelector)].find((button) => (button.dataset.toggleTabGroup || button.dataset.editTabGroup) === focusId)?.focus({ preventScroll: true });
}
function closeRepositoryTabTools() {
    const menu = $("#repository-tab-tools-menu");
    if (menu.matches(":popover-open"))
        menu.hidePopover();
}
function positionRepositoryTabTools() {
    const menu = $("#repository-tab-tools-menu");
    if (!menu.matches(":popover-open"))
        return;
    const viewport = document.documentElement;
    const scale = menu.getBoundingClientRect().width / menu.offsetWidth || 1;
    menu.style.maxWidth = `${Math.max(1, viewport.clientWidth - 24) / scale}px`;
    menu.style.maxHeight = `${Math.max(1, viewport.clientHeight - 24) / scale}px`;
    const anchor = $("#repository-tab-tools-toggle").getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    menu.style.right = `${Math.max(12, viewport.clientWidth - anchor.right) / scale}px`;
    menu.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, viewport.clientHeight - size.height - 12)) / scale}px`;
}
function renderRepositoryManager() {
    const search = $("#repository-manager-search").value.trim().toLocaleLowerCase();
    const groups = repositoryTabGroups();
    const ownerByRepository = new Map(groups.flatMap((group) => group.repositoryIds.map((id) => [id, group])));
    $("#repository-manager-list").innerHTML = state.workspace.repositories.filter((repository) => [repository.name, repository.path, ownerByRepository.get(repository.id)?.name].some((value) => String(value || "").toLocaleLowerCase().includes(search))).map((repository) => {
        const group = ownerByRepository.get(repository.id);
        return `<div class="repository-manager-row ${group ? `repo-tab-group-${group.color}` : ""}"><button type="button" class="repository-manager-open" data-open-managed-repository="${escapeHtml(repository.id)}"${isRepositoryDestination(repository.id) ? ' aria-current="page"' : ""}><span class="repo-dot" aria-hidden="true"></span><span><strong>${escapeHtml(repository.name)}</strong><small>${escapeHtml(repository.path)}</small>${group ? `<em>${escapeHtml(group.name)}${group.collapsed ? " · tabs hidden" : ""}</em>` : ""}</span></button><button type="button" class="repository-manager-offboard" data-offboard-managed-repository="${escapeHtml(repository.id)}" aria-label="Offboard ${escapeHtml(repository.name)}">Offboard</button></div>`;
    }).join("") || `<p class="empty-list">${state.workspace.repositories.length ? "No repositories match your search." : "No repositories connected yet."}</p>`;
}
function openRepositoryManager() {
    closeRepositoryTabTools();
    $("#repository-manager-search").value = "";
    renderRepositoryManager();
    if (showAppDialog("manage-repositories-dialog"))
        $("#repository-manager-search").focus();
}
function renderRepositoryTabGroupEditor(selectedRepositoryId = null) {
    const groups = repositoryTabGroups();
    const editing = groups.find((group) => group.id === state.editingRepositoryTabGroupId) || null;
    $("#repo-group-title").textContent = editing ? "Edit tab group" : "Create tab group";
    $("#repo-group-name").value = editing?.name || "";
    $("#delete-repo-group").classList.toggle("hidden", !editing);
    $("#repo-group-list").innerHTML = groups.map((group) => `<button class="repo-group-switch ${group.id === editing?.id ? "active" : ""}" type="button" data-edit-tab-group="${group.id}"><span class="repo-group-switch-color repo-tab-group-${group.color}"></span>${escapeHtml(group.name)}</button>`).join("");
    const selectedColor = editing?.color || "blue";
    $("#repo-group-colors").innerHTML = REPOSITORY_TAB_GROUP_COLORS.map((color) => `<label class="repo-group-color-option repo-tab-group-${color}" title="${color}"><input type="radio" name="repo-group-color" value="${color}" ${color === selectedColor ? "checked" : ""} /><span></span></label>`).join("");
    const selected = new Set(editing?.repositoryIds || (selectedRepositoryId ? [selectedRepositoryId] : []));
    const ownerByRepository = new Map(groups.flatMap((group) => group.repositoryIds.map((repositoryId) => [repositoryId, group])));
    $("#repo-group-members").innerHTML = state.workspace.repositories.map((repository) => {
        const owner = ownerByRepository.get(repository.id);
        const ownerText = owner && owner.id !== editing?.id ? `<small>Currently in ${escapeHtml(owner.name)}</small>` : "";
        return `<label class="repo-group-member"><input type="checkbox" name="repo-group-repository" value="${repository.id}" ${selected.has(repository.id) ? "checked" : ""} /><span><strong>${escapeHtml(repository.name)}</strong>${ownerText}</span></label>`;
    }).join("");
}
function openRepositoryTabGroupDialog(groupId = null, repositoryId = null) {
    const groups = repositoryTabGroups();
    state.editingRepositoryTabGroupId = groupId || (repositoryId ? null : groups[0]?.id || null);
    renderRepositoryTabGroupEditor(repositoryId);
    showAppDialog("repo-group-dialog");
    requestAnimationFrame(() => $("#repo-group-name").focus());
}
async function saveRepositoryTabGroup(event) {
    event.preventDefault();
    const name = $("#repo-group-name").value.trim();
    const repositoryIds = $$('input[name="repo-group-repository"]:checked').map((input) => input.value);
    if (!name)
        return toast("Give this tab group a name", "error");
    if (!repositoryIds.length)
        return toast("Select at least one repository", "error");
    const id = state.editingRepositoryTabGroupId || crypto.randomUUID();
    const color = $('input[name="repo-group-color"]:checked')?.value || "blue";
    const current = repositoryTabGroups();
    const existing = current.find((group) => group.id === id);
    const selected = new Set(repositoryIds);
    const remaining = current
        .filter((group) => group.id !== id)
        .map((group) => ({ ...group, repositoryIds: group.repositoryIds.filter((repositoryId) => !selected.has(repositoryId)) }))
        .filter((group) => group.repositoryIds.length);
    remaining.push({ id, name, color, collapsed: existing?.collapsed || false, repositoryIds });
    try {
        await persistRepositoryTabGroups(remaining);
        $("#repo-group-dialog").close();
        toast(`Saved ${name}`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function toggleRepositoryTabGroup(groupId) {
    const groups = repositoryTabGroups().map((group) => group.id === groupId ? { ...group, collapsed: !group.collapsed } : group);
    try {
        await persistRepositoryTabGroups(groups);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function deleteRepositoryTabGroup() {
    const group = repositoryTabGroups().find((item) => item.id === state.editingRepositoryTabGroupId);
    if (!group)
        return;
    try {
        await persistRepositoryTabGroups(repositoryTabGroups().filter((item) => item.id !== group.id));
        $("#repo-group-dialog").close();
        toast(`Removed ${group.name}; its repositories are still open`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function updateRepositoryTabOverflow() {
    const tabs = $("#repo-tabs");
    const rail = $("#repo-tab-rail");
    if (!tabs || !rail)
        return;
    const overflow = tabs.scrollWidth > rail.clientWidth + 2;
    $("#repo-tabs-scroll-left").classList.toggle("hidden", !overflow);
    $("#repo-tabs-scroll-right").classList.toggle("hidden", !overflow);
    const { canScrollLeft, canScrollRight } = repositoryTabScrollState(tabs);
    rail.classList.toggle("can-scroll-left", overflow && canScrollLeft);
    rail.classList.toggle("can-scroll-right", overflow && canScrollRight);
    $("#repo-tabs-scroll-left").disabled = !canScrollLeft;
    $("#repo-tabs-scroll-right").disabled = !canScrollRight;
}
function revealActiveRepositoryTab() {
    const tabs = $("#repo-tabs");
    const active = tabs?.querySelector(".repo-tab.active") || tabs?.querySelector(".repo-tab-group-chip.contains-active");
    if (!tabs || !active)
        return;
    revealRepositoryTab(active);
}
function repositoryTabScrollBehavior() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
}
function revealRepositoryTab(tab) {
    const tabs = $("#repo-tabs");
    const rail = tabs.getBoundingClientRect();
    const bounds = tab.getBoundingClientRect();
    const scale = rail.width / tabs.offsetWidth || 1;
    const left = repositoryTabRevealLeft({ scrollLeft: tabs.scrollLeft, clientWidth: tabs.clientWidth, scrollWidth: tabs.scrollWidth, tabLeft: bounds.left / scale, tabRight: bounds.right / scale, railLeft: rail.left / scale });
    if (left !== null)
        tabs.scrollTo({ left, behavior: repositoryTabScrollBehavior() });
}
async function openCloseRepositoryDialog(repositoryId) {
    openRepositoryOffboarding([repositoryId]);
}
function renderRepositoryOffboarding() {
    const selected = state.pendingOffboardingIds;
    $("#offboard-repository-list").innerHTML = state.workspace.repositories.map((repository) => `<label><input type="checkbox" name="offboardRepository" value="${escapeHtml(repository.id)}" ${selected.has(repository.id) ? "checked" : ""} /><span><strong>${escapeHtml(repository.name)}</strong><small>${escapeHtml(repository.path)}</small></span></label>`).join("");
    $("#confirm-offboard").disabled = !selected.size || $("#offboard-confirmation").value.trim().toLowerCase() !== "offboard";
}
function openRepositoryOffboarding(repositoryIds = []) {
    state.pendingOffboardingIds = new Set(repositoryIds.filter((id) => state.workspace.repositories.some((repository) => repository.id === id)));
    $("#offboard-confirmation").value = "";
    renderRepositoryOffboarding();
    showAppDialog("close-repo-dialog");
}
async function closeRepositoryTab(event) {
    event.preventDefault();
    const repositoryIds = [...state.pendingOffboardingIds];
    const confirmation = $("#offboard-confirmation").value.trim();
    if (!repositoryIds.length || confirmation.toLowerCase() !== "offboard")
        return;
    if (typeof repositoryIdeBridge !== "undefined" && repositoryIds.some(id => repositoryIdeBridge.isDirty(id))) {
        toast("Save or explicitly discard this repository’s unsaved editor files before offboarding it.", "error");
        return;
    }
    try {
        storeComposerDraft("repository");
        storeComposerDraft("global");
        const job = await api("/api/repository-offboarding/jobs", { method: "POST", body: { repositoryIds, confirmation } });
        $("#close-repo-dialog").close();
        state.backgroundJobs.unshift(job);
        state.backgroundJobStatuses.set(job.id, job.status);
        state.backgroundJobsMinimized = false;
        renderBackgroundJobs();
        toast(`${repositoryIds.length} ${repositoryIds.length === 1 ? "repository" : "repositories"} queued to disconnect. Chats and saved data will be kept.`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function activateRepository(repositoryId, { forceRefresh = false } = {}) {
    const repository = state.workspace.repositories.find((repo) => repo.id === repositoryId);
    if (!repository)
        return;
    if (!switchPrimaryView("repository", { updateUrl: false }))
        return;
    const groups = repositoryTabGroups();
    const hiddenGroup = groups.find((group) => group.collapsed && group.repositoryIds.includes(repositoryId));
    if (hiddenGroup)
        void persistRepositoryTabGroups(groups.map((group) => group.id === hiddenGroup.id ? { ...group, collapsed: false } : group)).catch((error) => toast(error.message, "error"));
    if (state.activeRepository?.id === repositoryId && !forceRefresh) {
        syncRepositoryWorkspacePresence();
        syncViewUrl("repository");
        requestAnimationFrame(revealActiveRepositoryTab);
        return;
    }
    storeComposerDraft("repository");
    repositoryTerminal?.minimize({ restoreFocus: false });
    state.workspace.activeRepositoryId = repositoryId;
    state.activeRepository = repository;
    syncIdeRunControls();
    if (typeof repositoryIdeBridge !== "undefined")
        void repositoryIdeBridge.sync();
    syncRepositoryWorkspacePresence();
    syncViewUrl("repository");
    state.activeJob = null;
    state.repositoryJobs = [];
    state.gitStatus = null;
    state.selectedGitChanges.clear();
    clearInterval(state.jobTimer);
    renderRepositoryTabs({ revealActive: true });
    renderContextTray("repository");
    resetTabSurface();
    restoreScopedComposer("repository");
    renderServices();
    updateLocalAIInfo();
    try {
        await Promise.all([
            api(`/api/repositories/${repositoryId}/activate`, { method: "POST" }),
            refreshActiveRepository(),
        ]);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function resetTabSurface() {
    branchPicker.close();
    if ($("#branch-dialog").open)
        $("#branch-dialog").close();
    state.branches = [];
    state.branchesRepositoryId = null;
    if (typeof gitStashes !== "undefined")
        gitStashes.repositoryChanged();
    renderGitBulkRevertNotice($("#git-bulk-revert-status"), state.gitBulkRevertReports.get(state.activeRepository?.id), document);
    const name = state.activeRepository?.name || "Repository";
    renderRepositoryContextSummary(document, { repository: state.activeRepository });
    $("#git-repo-name").textContent = name;
    $("#branch-name").textContent = "Loading…";
    renderBranchCopyButton();
    renderGitSyncState(null);
    $("#change-list").innerHTML = skeletonRows(5);
    $("#git-history").innerHTML = skeletonRows(5);
    $("#git-branches").innerHTML = skeletonRows(6, true);
    $("#repo-agent-tabs").innerHTML = "";
    $("#agent-output-card").classList.add("hidden");
    renderTaskConversation("repository", { messages: [] });
}
async function refreshActiveRepository({ refreshConversation = true, isCurrent = () => true } = {}) {
    if (!state.activeRepository || !isCurrent())
        return;
    const id = state.activeRepository.id;
    const knownJobIds = new Set([...state.repositoryJobs.map(job => job.id), state.activeJob?.id]);
    const requestToken = ++state.refreshToken;
    const current = () => isCurrent() && requestToken === state.refreshToken && state.activeRepository?.id === id;
    state.gitStatusVersion = (state.gitStatusVersion || 0) + 1;
    state.gitStatusLoading = true;
    setRefreshLoading($("#refresh-git"), true);
    renderRepositoryContextSummary(document, {
        repository: state.activeRepository, branch: state.gitStatus?.branch,
        changeCount: state.gitStatus?.files?.length, detached: state.gitStatus?.detached,
    });
    $("#git-repo-name").textContent = state.activeRepository.name;
    $("#local-codex-title").textContent = `${state.activeRepository.name} AI`;
    renderContextTray("repository");
    if (!state.gitStatus) {
        $("#branch-name").textContent = "Loading…";
        renderBranchCopyButton();
        renderGitSyncState(null);
        $("#change-list").innerHTML = skeletonRows(5);
        $("#git-history").innerHTML = skeletonRows(5);
        $("#git-branches").innerHTML = skeletonRows(6, true);
    }
    const results = await Promise.allSettled([
        (async () => {
            try {
                const status = await api(`/api/repositories/${id}/git/status`, { dedupe: false, cache: "no-store" });
                if (!current())
                    return;
                state.gitStatus = status;
                renderGitStatus();
            }
            finally {
                if (requestToken === state.refreshToken) {
                    state.gitStatusLoading = false;
                    setRefreshLoading($("#refresh-git"), false);
                }
            }
        })(),
        (async () => { const history = await api(`/api/repositories/${id}/git/history`); if (current())
            renderHistory(history); })(),
        (async () => { const branches = await api(`/api/repositories/${id}/git/branches`); if (current())
            renderBranches(branches); })(),
        (async () => {
            if (!refreshConversation)
                return;
            const [jobs, tasks] = await Promise.all([
                api(`/api/agents/jobs?repositoryId=${id}`), api(`/api/ai-tasks?scope=repository&repositoryId=${id}`),
            ]);
            if (!current())
                return;
            state.repositoryJobs = reconcileAgentJobs(jobs, state.repositoryJobs, state.activeJob, id, knownJobIds);
            state.repositoryTasks[id] = tasks;
            const preparingDraft = state.repositorySubmitting[id] && state.repositorySubmissions[id] && !state.repositorySubmissions[id].taskId && !state.activeTaskByRepository[id];
            const selectedLiveTask = state.repositoryJobs.some(job => job.taskId === state.activeTaskByRepository[id] && agentJobIsActive(job));
            if (!preparingDraft && !selectedLiveTask && !tasks.some((task) => task.id === state.activeTaskByRepository[id]))
                state.activeTaskByRepository[id] = tasks[0]?.id || null;
            renderTaskList("repository");
            if (state.currentView !== "repository") {
                renderAgentTabs("repository");
                return;
            }
            if (document.body.classList.contains("version-control-dock-open"))
                return;
            const selectedJob = state.repositoryJobs.find((job) => job.taskId === activeTaskId("repository") && agentJobIsActive(job));
            if (selectedJob?.taskId)
                await selectTask("repository", selectedJob.taskId, { background: true });
            else if (selectedJob)
                showRepositoryJob(selectedJob);
            else if (activeTaskId("repository"))
                await selectTask("repository", activeTaskId("repository"), { background: true });
            else {
                state.activeJob = null;
                renderModelControls("repository");
                $("#agent-output-card").classList.add("hidden");
                renderTaskConversation("repository", { messages: [] });
                renderAgentTabs("repository");
                const submission = composerSubmission("repository");
                if (submission)
                    setComposerPreparingState("repository", true, submission.providerName);
                else
                    setComposerActionState("repository", false);
            }
        })(),
    ]);
    const failed = results.find(result => result.status === "rejected");
    if (current() && failed)
        toast(failed.reason.message, "error");
}
async function refreshVisibleGitStatus({ force = false } = {}) {
    const id = state.activeRepository?.id;
    if (!id || document.hidden || (!force && !document.body.classList.contains("version-control-dock-open"))
        || state.gitStatusLoading || state.gitStatusPolling || state.gitActionRepositories?.has(id))
        return;
    const request = { id, version: state.gitStatusVersion };
    state.gitStatusPolling = request;
    try {
        const status = await api(`/api/repositories/${id}/git/status`, { dedupe: false, cache: "no-store", timeout: 5000 });
        if (state.activeRepository?.id !== id || state.gitStatusVersion !== request.version
            || state.gitStatusLoading || state.gitActionRepositories?.has(id)
            || document.hidden || (!force && !document.body.classList.contains("version-control-dock-open")))
            return;
        const filesChanged = !state.gitStatus || JSON.stringify(state.gitStatus.files) !== JSON.stringify(status.files);
        state.gitStatus = status;
        if (filesChanged) {
            const scrollers = [$("#change-list"), $("#git-changes")];
            const positions = scrollers.map((element) => element?.scrollTop || 0);
            renderGitStatus();
            scrollers.forEach((element, index) => { if (element)
                element.scrollTop = positions[index]; });
        }
        else
            renderGitHeader(status);
    }
    catch {
        if (state.activeRepository?.id === id && state.gitStatusVersion === request.version
            && !state.gitStatusLoading && !state.gitActionRepositories?.has(id)) {
            const label = $("#sync-state");
            label.title = "Git status could not be refreshed. This is the last known count; use Refresh to retry.";
            label.setAttribute("aria-label", label.title);
        }
    }
    finally {
        if (state.gitStatusPolling === request)
            state.gitStatusPolling = null;
    }
}
function renderGitSyncState(status) {
    const label = $("#sync-state");
    label.textContent = status ? [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ") : "";
    const counts = status ? [
        status.ahead ? `${status.ahead} commit${status.ahead === 1 ? "" : "s"} ahead` : "",
        status.behind ? `${status.behind} commit${status.behind === 1 ? "" : "s"} behind` : "",
    ].filter(Boolean).join(" and ") : "";
    label.title = status
        ? `${counts ? `${counts} the tracked upstream.` : "Git reports no ahead/behind commits for this checkout."} Fetch updates remote-tracking refs only; Pull integrates upstream commits into this checkout.\n${state.activeRepository?.path || ""}`.trim()
        : "Checking the selected checkout's Git status…";
    label.setAttribute("aria-label", label.title);
    $("#fetch-button").title = "Fetch updates remote-tracking refs only; it does not pull commits into this checkout.";
    $("#pull-button").title = "Pull upstream commits into this checkout (fast-forward only). Local edits are not discarded.";
}
function renderAgentTabs(scope) {
    const global = scope === "global";
    const jobs = (global ? state.globalJobs : state.repositoryJobs)
        .filter((job) => isChatAgentJob(job) && chatRevisionState.acceptsJob(job, checkpointTasks.get(scope)));
    const selected = global ? state.globalJob : state.activeJob;
    const active = jobBelongsToCurrentChat(scope, selected) ? selected : null;
    const target = global ? $("#global-agent-tabs") : $("#repo-agent-tabs");
    renderChatMarkup(target, jobs.map((job, index) => `<button data-chat-render-key="${escapeHtml(job.id)}" class="agent-tab ${active?.id === job.id ? "active" : ""} ${agentJobIsActive(job) ? "running" : ""}" data-agent-job="${job.id}" data-agent-scope="${scope}" title="${escapeHtml(job.prompt)}"><span class="tiny-state"></span>${index === 0 ? "Latest · " : ""}${escapeHtml(job.prompt.slice(0, 34))}</button>`).join(""));
}
function showRepositoryJob(job) {
    if (!jobBelongsToCurrentChat("repository", job))
        return;
    job = reconcileAgentJob(state.activeJob, job);
    const scrollState = captureLiveScroll(conversationScroller("repository"));
    const outputScrollState = captureLiveScroll($("#agent-output"));
    state.activeJob = job;
    refreshQueuedSteeringControls("repository");
    $("#agent-output-card").classList.remove("hidden");
    const statusLabel = agentJobStatusLabel(job);
    setTextIfChanged($("#agent-status"), `${statusLabel}${job.startedAt ? ` · ${formatMessageTimestamp(job.startedAt)}` : ""}`);
    renderChatContent($("#agent-output"), agentDisplayText(job));
    renderAgentQuestionForScope("repository");
    const running = agentJobIsActive(job);
    setComposerActionState("repository", running);
    $("#agent-status-dot").style.animation = running ? "" : "none";
    renderAgentTabs("repository");
    restoreLiveScroll($("#agent-output"), outputScrollState);
    restoreLiveScroll(conversationScroller("repository"), scrollState);
    clearInterval(state.jobTimer);
    if (running)
        state.jobTimer = setInterval(pollAgent, 1000);
}
function showGlobalJob(job) {
    if (!jobBelongsToCurrentChat("global", job))
        return;
    job = reconcileAgentJob(state.globalJob, job);
    const scrollState = captureLiveScroll(conversationScroller("global"));
    const outputScrollState = captureLiveScroll($("#global-agent-output"));
    state.globalJob = job;
    refreshQueuedSteeringControls("global");
    $("#global-agent-output-card").classList.remove("hidden");
    const statusLabel = agentJobStatusLabel(job);
    setTextIfChanged($("#global-agent-status"), `${statusLabel}${job.startedAt ? ` · ${formatMessageTimestamp(job.startedAt)}` : ""}`);
    renderChatContent($("#global-agent-output"), agentDisplayText(job));
    renderAgentQuestionForScope("global");
    const running = agentJobIsActive(job);
    setComposerActionState("global", running);
    $("#global-agent-status-dot").style.animation = running ? "" : "none";
    renderAgentTabs("global");
    restoreLiveScroll($("#global-agent-output"), outputScrollState);
    restoreLiveScroll(conversationScroller("global"), scrollState);
    clearInterval(state.globalJobTimer);
    if (running)
        state.globalJobTimer = setInterval(pollGlobalAgent, 1000);
}
function renderBranchCopyButton(branch = "") {
    const button = $("#copy-branch-button");
    const repositoryId = state.activeRepository?.id || "";
    if (button.dataset.branch === branch && button.dataset.repositoryId === repositoryId)
        return;
    button.dataset.branch = branch;
    button.dataset.repositoryId = repositoryId;
    button.dataset.copyRevision = String(Number(button.dataset.copyRevision || 0) + 1);
    button.disabled = !branch || !repositoryId;
    button.classList.remove("copied");
    button.title = "Copy branch name";
    button.setAttribute("aria-label", button.title);
    $("#branch-copy-status").textContent = "";
}
async function copyCurrentBranchName() {
    const button = $("#copy-branch-button");
    const branch = button.dataset.branch;
    if (button.disabled || !branch || button.dataset.repositoryId !== state.activeRepository?.id || branch !== state.gitStatus?.branch)
        return;
    const revision = String(Number(button.dataset.copyRevision || 0) + 1);
    button.dataset.copyRevision = revision;
    button.disabled = true;
    button.classList.remove("copied");
    button.title = "Copying branch name…";
    button.setAttribute("aria-label", button.title);
    $("#branch-copy-status").textContent = "";
    const current = () => button.dataset.copyRevision === revision;
    try {
        await navigator.clipboard.writeText(branch);
        if (!current())
            return;
        button.classList.add("copied");
        button.title = "Copied";
        button.setAttribute("aria-label", "Branch name copied");
        $("#branch-copy-status").textContent = "Branch name copied";
        setTimeout(() => {
            if (!current())
                return;
            button.classList.remove("copied");
            button.title = "Copy branch name";
            button.setAttribute("aria-label", button.title);
            $("#branch-copy-status").textContent = "";
        }, 1200);
    }
    catch {
        if (current()) {
            button.title = "Copy branch name";
            button.setAttribute("aria-label", button.title);
            $("#branch-copy-status").textContent = "Could not copy branch name. Please try again.";
            toast("Could not copy branch name. Please try again.", "error");
        }
    }
    finally {
        if (current())
            button.disabled = false;
    }
}
function renderGitHeader(status) {
    $("#branch-name").textContent = status.branch;
    renderBranchCopyButton(status.detached ? "" : status.branch);
    renderRepositoryContextSummary(document, {
        repository: state.activeRepository, branch: status.branch,
        changeCount: status.files.length, detached: status.detached,
    });
    renderGitSyncState(status);
}
function renderGitStatus() {
    const status = state.gitStatus;
    renderGitHeader(status);
    const staged = status.files.filter((file) => file.staged);
    const changed = status.files.filter((file) => file.changed);
    const validSelections = new Set([
        ...staged.map((file) => gitSelectionKey(file.file, true)),
        ...changed.map((file) => gitSelectionKey(file.file, false)),
    ]);
    state.selectedGitChanges = new Set([...state.selectedGitChanges].filter((key) => validSelections.has(key)));
    const renderGroup = (title, files, stagedView) => files.length ? `
    <div class="change-group-title">${title}<span>${files.length}</span></div>
    ${files.map((file) => changeRow(file, stagedView)).join("")}` : "";
    $("#change-list").innerHTML = renderGroup("STAGED", staged, true) + renderGroup("CHANGES", changed, false) || `<div class="empty-list">Clean working tree.<br />There are no local changes in this repository.</div>`;
    renderGitSelectionToolbar();
}
function gitSelectionKey(file, stagedView) {
    return `${stagedView ? "staged" : "changed"}:${file}`;
}
function changeRow(file, stagedView) {
    const displayName = file.file.split("/").at(-1);
    const directory = file.file.includes("/") ? file.file.slice(0, file.file.lastIndexOf("/")) : "repository root";
    const letter = file.status === "untracked" ? "U" : file.status === "deleted" ? "D" : file.status === "added" ? "A" : "M";
    const selectionKey = gitSelectionKey(file.file, stagedView);
    const isNew = file.untracked || file.index === "A" || file.status === "added";
    const fileAction = isNew ? "delete" : "revert";
    const fileActionLabel = isNew ? "Delete" : "Revert";
    const busy = state.gitActionRepositories.has(state.activeRepository?.id);
    return `<div class="change-row" data-file="${escapeHtml(file.file)}" data-staged="${stagedView}">
    <input class="change-selector" type="checkbox" aria-label="Select ${escapeHtml(file.file)}" data-git-selection="${escapeHtml(selectionKey)}" ${state.selectedGitChanges.has(selectionKey) ? "checked" : ""} ${busy ? "disabled" : ""} />
    <span class="file-status">${letter}</span>
    <span class="file-name" tabindex="0" title="${escapeHtml(file.file)}"><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml(directory)}</small></span>
    <span class="change-actions">
      <button data-git-action="${stagedView ? "unstage" : "stage"}" title="${stagedView ? "Unstage this file; keep its working changes" : "Stage this file"}" ${busy ? "disabled" : ""}>${stagedView ? "Unstage" : "Stage"}</button>
      <button class="git-file-destructive-action" data-git-file-action="${fileAction}" aria-label="${fileActionLabel} ${escapeHtml(file.file)}" title="${isNew ? "Delete this new file from disk and staging, with a recovery copy" : "Revert this file's staged and working changes to HEAD, with recovery copies"}" ${busy ? "disabled" : ""}>${fileActionLabel}</button>
    </span>
  </div>`;
}
async function runGitFileAction(file, action) {
    const repository = state.activeRepository;
    if (!repository || !file || !["delete", "revert"].includes(action))
        return;
    const id = repository.id;
    const initialDiff = state.diffEditor;
    const current = () => state.activeRepository?.id === id && state.currentView === "repository";
    const dirty = () => repositoryIdeBridge.isFileDirty(id, file)
        || (state.diffEditor?.repositoryId === id && state.diffEditor.file === file && diffEditIsDirty());
    if (!current())
        return;
    if (state.gitActionRepositories.has(id))
        return toast("A Git operation is already running for this repository.");
    if (dirty())
        return toast("Save or discard this file's unsaved editor changes first. Your draft has been kept.", "error");
    state.gitActionRepositories.add(id);
    renderGitStatus();
    let submitted = false;
    try {
        const preview = await api(`/api/repositories/${encodeURIComponent(id)}/git/file-action-preview?file=${encodeURIComponent(file)}&action=${action}`, { dedupe: false });
        if (!current())
            return;
        if (!preview.allowed || !preview.revision)
            return toast(preview.reason || "This file cannot be changed safely by this action.", "error");
        const explanation = action === "delete"
            ? `Delete this NEW file from the working folder${preview.staged ? " and remove its staged addition" : ""}?`
            : "Revert ALL staged and working changes in this file to the committed HEAD version?";
        if (!confirm(`${repository.name} · ${file}\n\n${explanation}\nOnly this file is affected; unrelated files are kept.\n\nArgus saves a local recovery copy before changing anything.\nRecovery location: ${preview.recoveryDirectory}`))
            return;
        if (!current() || dirty()) {
            if (dirty())
                toast("The editor now has unsaved changes. Nothing was changed; your draft was kept.", "error");
            return;
        }
        submitted = true;
        state.gitStatusVersion++;
        const result = await api(`/api/repositories/${encodeURIComponent(id)}/git/file-action?action=${action}`, {
            method: "POST", body: { file, expectedRevision: preview.revision },
        });
        state.gitStatusVersion++;
        const recovery = result.recoveryPaths?.length ? ` Recovery: ${result.recoveryPaths.join("; ")}` : "";
        toast(`${result.message || (action === "delete" ? "New file deleted." : "File reverted.")}${recovery}`, result.refreshRequired ? "error" : undefined);
    }
    catch (error) {
        toast(`${error.message}${submitted ? " Refresh and inspect the file before trying again; the request is not retried automatically." : ""}`, "error");
    }
    finally {
        if (submitted) {
            repositoryIdeBridge.invalidateSavedFile(id, file);
            try {
                const refreshed = await repositoryIdeBridge.refreshAfterExternalChange?.(id, { paths: [file] });
                if (refreshed?.failed?.length)
                    toast(`The file action finished, but the editor could not refresh: ${refreshed.failed.map(item => `${item.path}: ${item.message}`).join("; ")}`, "error");
            }
            catch {
                toast("The file action finished, but the editor could not refresh. Reopen the file to inspect it.", "error");
            }
            if (state.diffEditor === initialDiff && initialDiff?.repositoryId === id && initialDiff.file === file && !diffEditIsDirty())
                closeDiffDialog();
        }
        state.gitActionRepositories.delete(id);
        if (current()) {
            if (submitted) {
                try {
                    await refreshActiveRepository();
                }
                catch {
                    toast("Source Control could not refresh. Refresh it before another file action.", "error");
                }
            }
            else
                renderGitStatus();
        }
    }
}
function renderGitSelectionToolbar() {
    const toolbar = $("#change-selection-toolbar");
    if (!toolbar)
        return;
    const selected = [...state.selectedGitChanges];
    const changedCount = selected.filter((key) => key.startsWith("changed:")).length;
    const stagedCount = selected.filter((key) => key.startsWith("staged:")).length;
    toolbar.classList.toggle("hidden", selected.length === 0);
    $("#change-selection-count").textContent = `${selected.length} selected`;
    $("#stage-selected-files").classList.toggle("hidden", changedCount === 0);
    $("#unstage-selected-files").classList.toggle("hidden", stagedCount === 0);
    const busy = state.gitActionRepositories.has(state.activeRepository?.id);
    for (const id of ["clear-change-selection", "stage-selected-files", "unstage-selected-files", "revert-selected-files"]) {
        const button = $(`#${id}`);
        if (button)
            button.disabled = busy;
    }
    renderGitBulkRevertNotice($("#git-bulk-revert-status"), state.gitBulkRevertReports.get(state.activeRepository?.id), document);
}
async function runSelectedGitAction(action) {
    if (state.gitActionRepositories.has(state.activeRepository?.id))
        return toast("A Git operation is already running for this repository.");
    const prefix = action === "stage" ? "changed:" : "staged:";
    const files = [...state.selectedGitChanges]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    if (!files.length)
        return;
    state.selectedGitChanges.clear();
    renderGitSelectionToolbar();
    await gitAction(action, { files });
}
async function runSelectedGitRevert() {
    const repository = state.activeRepository;
    if (!repository || state.currentView !== "repository")
        return;
    const id = repository.id;
    const current = () => state.activeRepository?.id === id && state.currentView === "repository";
    if (state.gitActionRepositories.has(id))
        return toast("A Git operation is already running for this repository.");
    let files;
    try {
        files = gitBulkRevertSelection(state.selectedGitChanges);
    }
    catch (error) {
        toast(error.message, "error");
        return;
    }
    if (!files.length)
        return;
    const selected = [...state.selectedGitChanges].sort();
    const sameSelection = () => JSON.stringify([...state.selectedGitChanges].sort()) === JSON.stringify(selected);
    const dirtyFiles = () => files.filter(({ file }) => repositoryIdeBridge.isFileDirty(id, file)
        || (state.diffEditor?.repositoryId === id && state.diffEditor.file === file && diffEditIsDirty())).map(item => item.file);
    const assertClean = () => {
        const dirty = dirtyFiles();
        if (dirty.length)
            throw new Error(`Save or explicitly discard unsaved editor changes before reverting:\n${dirty.join("\n")}\nYour drafts have been kept.`);
    };
    try {
        assertClean();
    }
    catch (error) {
        toast(error.message, "error");
        return;
    }
    const initialDiff = state.diffEditor;
    state.gitActionRepositories.add(id);
    const previewVersion = ++state.gitStatusVersion;
    const previewCurrent = () => current() && state.gitStatusVersion === previewVersion && sameSelection();
    state.gitBulkRevertReports.delete(id);
    renderGitStatus();
    let submitted = false;
    let recoveryDirectory;
    try {
        const preview = await api(`/api/repositories/${encodeURIComponent(id)}/git/bulk-revert/preview`, { method: "POST", body: { files }, dedupe: false });
        if (!previewCurrent())
            return;
        const payload = validateGitBulkRevertPreview(preview, files);
        recoveryDirectory = preview.recoveryDirectory;
        assertClean();
        const confirmed = await confirmGitBulkRevert({ document, repository, files, preview, isCurrent: previewCurrent });
        if (!confirmed || !previewCurrent())
            return;
        assertClean();
        submitted = true;
        state.gitStatusVersion++;
        const result = await api(`/api/repositories/${encodeURIComponent(id)}/git/bulk-revert`, { method: "POST", body: { files: payload } });
        const complete = result.ok === true && !result.partial
            && Array.isArray(result.results) && result.results.length === files.length
            && files.every(item => result.results.some(row => row.file === item.file && row.staged === item.staged && row.status === "reverted"));
        const message = !complete && result.ok === true
            ? "The batch result was incomplete. Inspect each file and its recovery copy before trying again; success has not been confirmed."
            : result.message || (complete ? `${files.length} selected file sections reverted. Unselected changes were kept.` : "The batch was not fully confirmed. Inspect each file result before trying again.");
        state.gitBulkRevertReports.set(id, { message, results: result.results, recoveryPaths: result.recoveryPaths, error: !complete });
        if (complete && current() && sameSelection())
            state.selectedGitChanges.clear();
        toast(`${repository.name}: ${message}`, complete ? undefined : "error");
    }
    catch (error) {
        const message = `${error.message}${submitted ? "\nRefresh and inspect the selected files before trying again. The request is not retried automatically; any applied files have local recovery copies." : ""}`;
        state.gitBulkRevertReports.set(id, { message, recoveryPaths: submitted && recoveryDirectory ? [recoveryDirectory] : [], error: true });
        toast(`${repository.name}: ${message}`, "error");
    }
    finally {
        if (submitted) {
            state.gitStatusVersion++;
            for (const { file } of files)
                repositoryIdeBridge.invalidateSavedFile(id, file);
            try {
                const refreshed = await repositoryIdeBridge.refreshAfterExternalChange?.(id, { paths: files.map(item => item.file) });
                if (refreshed?.failed?.length)
                    toast(`Some editor views could not refresh: ${refreshed.failed.map(item => `${item.path}: ${item.message}`).join("; ")}. Reopen them to inspect disk changes.`, "error");
            }
            catch {
                toast("The editor could not refresh after the batch. Reopen the selected files to inspect their disk contents; unsaved drafts are kept.", "error");
            }
            if (state.diffEditor === initialDiff && initialDiff?.repositoryId === id && files.some(item => item.file === initialDiff.file) && !diffEditIsDirty())
                closeDiffDialog();
        }
        state.gitActionRepositories.delete(id);
        if (current()) {
            if (submitted) {
                try {
                    await refreshActiveRepository({ refreshConversation: false });
                }
                catch {
                    toast("Source Control could not refresh. Refresh before another revert.", "error");
                }
            }
            else if (state.gitStatus)
                renderGitStatus();
            renderGitSelectionToolbar();
        }
    }
}
function renderHistory(history) {
    $("#git-history").innerHTML = history.length ? history.map((commit) => `<div class="history-row"><span class="history-node"></span><div><strong>${escapeHtml(commit.subject)}</strong><small>${escapeHtml(commit.shortHash)} · ${escapeHtml(commit.author)} · ${relativeTime(commit.date)}</small></div></div>`).join("") : `<div class="empty-list">No commits yet.</div>`;
}
function renderBranches(branches) {
    state.branches = branches;
    state.branchesRepositoryId = state.activeRepository?.id;
    $("#git-branches").innerHTML = branches.filter((branch) => branch.selectable).map((branch) => `<button class="branch-row ${branch.current ? "current" : ""}" data-choose-branch="${escapeHtml(branch.name)}">${branchIcon}<strong>${escapeHtml(branch.name)}</strong>${branch.upstream ? `<small>→ ${escapeHtml(branch.upstream)}</small>` : branch.type === "remote" ? `<small>remote</small>` : ""}</button>`).join("");
}
const branchPicker = createBranchPickerLoader({ api: (...args) => api(...args), onChange: view => {
        if (!$("#branch-dialog").open || state.activeRepository?.id !== view.repositoryId)
            return;
        renderBranchPicker($("#branch-search-input").value);
        if ($("#branch-form").elements.operation.value === "create")
            renderCreateBranchOptions({ preserve: true });
        updateBranchConfirmation();
    } });
function renderBranchPicker(query = "") {
    const view = branchPicker.snapshot();
    const list = $("#branch-picker-list"), focused = document.activeElement?.closest?.("[data-branch-candidate]")?.dataset.branchCandidate;
    const scrollTop = list.scrollTop;
    list.innerHTML = branchPickerMarkup({ ...view, query, selected: $("#branch-form").elements.branch.value, branchIcon });
    list.scrollTop = scrollTop;
    if (focused)
        [...list.querySelectorAll("[data-branch-candidate]")].find(row => row.dataset.branchCandidate === focused)?.focus({ preventScroll: true });
    const status = $("#branch-picker-status");
    status.textContent = view.loading ? "Refreshing branches…" : view.notice;
    status.hidden = !status.textContent;
}
function renderCreateBranchOptions({ preserve = false } = {}) {
    const input = $("#create-branch-start");
    const candidates = branchPicker.snapshot().branches.filter((branch) => branch.selectable);
    const current = candidates.find((branch) => branch.current)?.name || candidates[0]?.name || "";
    $("#create-branch-options").innerHTML = candidates.map((branch) => `<option value="${escapeHtml(branch.name)}">${branch.current ? "Current branch" : branch.type === "remote" ? "Remote branch" : "Local branch"}</option>`).join("");
    if (!preserve || !input.value)
        input.value = current;
}
function selectBranchCandidate(branchName) {
    const branch = branchPicker.snapshot().branches.find((item) => item.selectable && item.name === branchName);
    if (!branch)
        return;
    $("#branch-form").elements.branch.value = branchName;
    updateBranchConfirmation();
    renderBranchPicker($("#branch-search-input").value);
}
function updateBranchConfirmation() {
    const form = $("#branch-form");
    const operation = form.elements.operation.value;
    const sourceName = operation === "create" ? form.elements.createStartPoint.value : form.elements.branch.value;
    const view = branchPicker.snapshot();
    const branch = view.branches.find((item) => item.selectable && item.name === sourceName);
    const newName = form.elements.newBranch.value.trim();
    const button = $("#confirm-branch-switch");
    if (view.repositoryId !== state.activeRepository?.id || state.gitActionRepositories.has(view.repositoryId)) {
        button.disabled = true;
        button.textContent = "Git operation in progress…";
        return;
    }
    if (operation === "create") {
        button.disabled = !branch || !newName;
        button.textContent = "Create and switch";
        return;
    }
    button.disabled = !branch || branch.current;
    button.textContent = branch?.current ? "Current branch" : branch?.type === "remote" ? "Track and switch" : "Switch branch";
}
function setBranchMode(mode) {
    const create = mode === "create";
    const form = $("#branch-form");
    form.elements.operation.value = create ? "create" : "switch";
    $$("[data-branch-mode]").forEach((button) => button.classList.toggle("active", button.dataset.branchMode === mode));
    $("#create-branch-fields").classList.toggle("hidden", !create);
    $("#switch-branch-fields").classList.toggle("hidden", create);
    $("#branch-dialog-title").textContent = create ? "Create branch" : "Switch branch";
    $("#branch-dialog-context").textContent = create
        ? `${state.activeRepository.name} · choose any branch as the starting point`
        : `${state.activeRepository.name} · currently on ${state.gitStatus?.branch || "unknown"}`;
    updateBranchConfirmation();
    if (create) {
        renderCreateBranchOptions();
        updateBranchConfirmation();
        setTimeout(() => form.elements.newBranch.focus(), 20);
    }
    else {
        setTimeout(() => $("#branch-search-input").focus(), 20);
    }
}
function openBranchSelector(preselectedBranch = "") {
    if (!state.activeRepository)
        return;
    const id = state.activeRepository.id;
    if (state.gitActionRepositories.has(id))
        return toast("A Git operation is already running for this repository.");
    if (!showAppDialog("branch-dialog"))
        return;
    $("#branch-dialog-context").textContent = `${state.activeRepository.name} · currently on ${state.gitStatus?.branch || "unknown"}`;
    $("#dirty-branch-warning").classList.toggle("hidden", !(state.gitStatus?.files.length));
    $("#branch-search-input").value = "";
    $("#branch-form").elements.branch.value = "";
    $("#branch-form").elements.newBranch.value = "";
    $("#branch-form").elements.operation.value = "switch";
    $("#branch-picker-list").scrollTop = 0;
    void branchPicker.open(id, state.branchesRepositoryId === id ? state.branches : []);
    setBranchMode("switch");
    $("#confirm-branch-switch").disabled = true;
    $("#confirm-branch-switch").textContent = "Switch branch";
    renderBranchPicker();
    if (preselectedBranch)
        selectBranchCandidate(preselectedBranch);
    setTimeout(() => $("#branch-search-input").focus(), 30);
}
async function switchBranch(event) {
    event.preventDefault();
    const snapshot = branchPicker.snapshot(), id = snapshot.repositoryId;
    if (!id || id !== state.activeRepository?.id)
        return toast("The repository changed. Reopen the branch picker before switching.", "error");
    if (state.gitActionRepositories.has(id))
        return toast("A Git operation is already running for this repository.");
    const form = new FormData(event.currentTarget);
    const branch = form.get("branch");
    const create = form.get("operation") === "create";
    const newBranch = String(form.get("newBranch") || "").trim();
    const startPoint = create ? String(form.get("createStartPoint") || "") : branch;
    const source = snapshot.branches.find(item => item.selectable && item.name === startPoint);
    if (!source || (!create && source.current))
        return;
    if (create && !newBranch)
        return toast("Enter the new branch name", "error");
    state.gitActionRepositories.add(id);
    state.gitStatusVersion++;
    updateBranchConfirmation();
    try {
        const result = await api(`/api/repositories/${encodeURIComponent(id)}/git/${create ? "branch" : "switch"}`, {
            method: "POST",
            body: create ? { name: newBranch, startPoint } : { branch },
        });
        if (branchPicker.snapshot().repositoryId === id)
            $("#branch-dialog").close();
        toast(result.output?.trim() || (create ? `Created ${newBranch} from ${startPoint}` : `Switched to ${branch}`));
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        state.gitActionRepositories.delete(id);
        state.gitStatusVersion++;
        updateBranchConfirmation();
        if (state.activeRepository?.id === id)
            await refreshActiveRepository();
    }
}
async function navigateEmbeddedDiff(context, hit, isCurrent) {
    const prefix = `/api/repositories/${encodeURIComponent(context.repositoryId)}`;
    const disk = await api(`${prefix}/ide/file?path=${encodeURIComponent(context.file)}`, { dedupe: false });
    if (!isCurrent())
        return false;
    if (context.staged && disk.content !== context.afterContent) {
        const workingDiff = await api(`${prefix}/git/diff?file=${encodeURIComponent(context.file)}&staged=false`, { dedupe: false });
        disk.workingDiff = { ...workingDiff, rows: expandToFullFile(parseUnifiedDiff(workingDiff.diff), workingDiff.beforeContent, workingDiff.afterContent).rows };
    }
    if (!isCurrent())
        return false;
    const source = resolveDiffNavigationPosition(context, hit, disk.content, disk.workingDiff);
    if (!source)
        throw new Error("This snapshot line cannot be mapped safely to the saved working file. Open the current source to navigate it.");
    const kind = ["declaration", "typeDefinition", "references", "implementation"].includes(hit.kind) ? hit.kind : "definition";
    const result = await api(`${prefix}/ide/navigate`, { method: "POST", body: { ...source, kind, expectedHash: disk.contentHash } });
    if (!isCurrent())
        return false;
    if (!result.locations?.length)
        throw new Error(result.notice || "No matching location found. Check Language tools or wait for indexing.");
    return repositoryIdeBridge.revealNavigation(context.repositoryId, { ...source, expectedHash: disk.contentHash }, { ...result, kind }, isCurrent);
}
async function showDiff(file, staged, location = {}, isValid = () => true) {
    if (state.diffEditor?.busy || !isValid())
        return false;
    const loadSequence = state.diffLoadSequence = (state.diffLoadSequence || 0) + 1;
    try {
        const repository = state.activeRepository;
        if (!repository)
            return;
        const fileSnapshotRequest = repositoryIdeBridge.isVisible(repository.id) ? null
            : api(`/api/repositories/${repository.id}/file?path=${encodeURIComponent(file)}`).catch(() => null);
        const result = await api(`/api/repositories/${repository.id}/git/diff?file=${encodeURIComponent(file)}&staged=${staged}`);
        if (!isValid() || state.diffLoadSequence !== loadSequence || state.activeRepository?.id !== repository.id)
            return false;
        if (repositoryIdeBridge.isVisible(repository.id)) {
            if (!closeOpenDialogs())
                return;
            let navigationRows;
            const context = { repositoryId: repository.id, file, staged, beforeContent: result.beforeContent, afterContent: result.afterContent,
                get rows() { return navigationRows ||= expandToFullFile(parseUnifiedDiff(result.diff), result.beforeContent, result.afterContent).rows; },
                changes: result.changes || [], revert: result.revert, busy: false };
            const isCurrent = () => state.diffLoadSequence === loadSequence && state.currentView === "repository"
                && state.activeRepository?.id === repository.id && repositoryIdeBridge.isVisible(repository.id);
            setTaskPanelCollapsed("repository", true, false);
            const shown = await repositoryIdeBridge.openDiff(repository.id, {
                path: file, before: result.beforeContent ?? "", after: result.afterContent ?? "", staged,
                line: location.line, column: location.column,
                title: `${file.split("/").pop()} · ${staged ? "Staged diff" : "Working diff"}`,
                beforeLabel: staged ? "HEAD" : "Staged index", afterLabel: staged ? "Staged index" : "Working tree",
                onNavigate: (hit, editorCurrent) => navigateEmbeddedDiff(context, hit, () => isCurrent() && editorCurrent()),
                changes: context.changes, revert: context.revert,
                onRevertChange: (changeId, editorCurrent) => revertIdeDiffChange(context, changeId, () => isCurrent() && editorCurrent(), editorCurrent),
            }, () => isValid() && isCurrent());
            queueAppNavigation();
            return shown;
        }
        const fileSnapshot = await (fileSnapshotRequest
            || api(`/api/repositories/${repository.id}/file?path=${encodeURIComponent(file)}`).catch(() => null));
        if (!isValid() || state.diffLoadSequence !== loadSequence || state.activeRepository?.id !== repository.id)
            return false;
        const parsed = expandToFullFile(parseUnifiedDiff(result.diff), result.beforeContent, result.afterContent);
        let dialog = $("#diff-dialog");
        if (!dialog) {
            dialog = document.createElement("dialog");
            dialog.id = "diff-dialog";
            dialog.innerHTML = `<div class="diff-window">
        <header class="diff-titlebar"><div><strong id="diff-file"></strong><small id="diff-scope"></small></div><div class="diff-stats"><span id="diff-additions"></span><span id="diff-deletions"></span></div><button id="diff-revert-file" class="diff-edit-button diff-revert-button" type="button">Revert changes</button><button id="diff-edit-file" class="diff-edit-button" type="button">Edit current file</button><button id="diff-cancel-edit" class="diff-edit-button hidden" type="button">Cancel edit</button><button id="diff-save-file" class="primary-button diff-save-button hidden" type="button">Save file</button><button class="icon-button" data-close-diff aria-label="Close diff">×</button></header>
        <div class="diff-column-headers"><div class="diff-side-title old"><strong>Before</strong><small id="diff-before-label">HEAD</small></div><div class="diff-header-divider"></div><div class="diff-side-title new"><strong>After</strong><small id="diff-after-label">Working tree</small></div></div>
        <div class="diff-body"><div id="diff-split-content" class="diff-split-content"><div id="diff-before-scroll" class="diff-pane-scroller" data-diff-pane="before"><div id="diff-before-content" class="diff-side-content"></div></div><div class="diff-pane-divider" aria-hidden="true"></div><div id="diff-after-scroll" class="diff-pane-scroller" data-diff-pane="after"><div id="diff-after-content" class="diff-side-content"></div></div></div><aside id="diff-overview-ruler" class="diff-overview-ruler" aria-label="Diff change overview" title="Click to jump through changes"></aside></div>
        <div id="diff-file-editor" class="diff-file-editor hidden"><pre id="diff-editor-lines" aria-hidden="true"></pre><textarea id="diff-editor-text" aria-label="Edit current file" spellcheck="false"></textarea></div>
        <div id="diff-navigation-status" class="diff-navigation-status" role="status">Cmd/Ctrl-click a symbol to open its definition in the current working file.</div>
      </div>`;
            document.body.append(dialog);
            state.diffNavigation = createDiffNavigation({
                dialog, document,
                getContext: () => dialog.open && !state.diffEditor?.busy && state.diffEditor?.repositoryId === state.activeRepository?.id
                    && $("#diff-file-editor").classList.contains("hidden") ? state.diffEditor : null,
                readFile: async (context, signal) => {
                    const prefix = `/api/repositories/${encodeURIComponent(context.repositoryId)}`;
                    const disk = await api(`${prefix}/ide/file?path=${encodeURIComponent(context.file)}`, { signal, dedupe: false });
                    if (context.staged && disk.content !== context.afterContent) {
                        const workingDiff = await api(`${prefix}/git/diff?file=${encodeURIComponent(context.file)}&staged=false`, { signal, dedupe: false });
                        disk.workingDiff = { ...workingDiff, rows: expandToFullFile(parseUnifiedDiff(workingDiff.diff), workingDiff.beforeContent, workingDiff.afterContent).rows };
                    }
                    return disk;
                },
                navigate: (context, body, signal) => api(`/api/repositories/${encodeURIComponent(context.repositoryId)}/ide/navigate`, { method: "POST", body, signal }),
                reveal: async (context, source, result, isCurrent) => {
                    const shown = await repositoryIdeBridge.revealNavigation(context.repositoryId, source, result, isCurrent);
                    if (!shown || !isCurrent())
                        return false;
                    closeDiffDialog();
                    setVersionControlDockOpen(false, false);
                    setTaskPanelCollapsed("repository", true, false);
                    repositoryIdeBridge.focus();
                    return true;
                },
                onStatus: (message, kind) => { const status = $("#diff-navigation-status"); status.textContent = message; status.dataset.kind = kind || ""; },
            });
            dialog.addEventListener("click", (event) => {
                if (event.target.matches("[data-close-diff]"))
                    closeDiffDialog();
                else if (event.target.matches("#diff-edit-file"))
                    setDiffEditMode(true);
                else if (event.target.matches("#diff-cancel-edit"))
                    cancelDiffEdit();
                else if (event.target.matches("#diff-save-file"))
                    saveDiffEdit();
                else if (event.target.matches("#diff-revert-file"))
                    revertDiffChanges();
                else if (event.target.closest("[data-revert-change]"))
                    revertDiffChange(event.target.closest("[data-revert-change]").dataset.revertChange);
            });
            dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDiffDialog(); });
            $("#diff-editor-text").addEventListener("input", updateDiffEditorLines);
            $("#diff-editor-text").addEventListener("scroll", (event) => { $("#diff-editor-lines").scrollTop = event.currentTarget.scrollTop; });
            $("#diff-overview-ruler").addEventListener("click", (event) => {
                const ruler = event.currentTarget;
                const ratio = Math.max(0, Math.min(1, (event.clientY - ruler.getBoundingClientRect().top) / ruler.clientHeight));
                [$("#diff-before-scroll"), $("#diff-after-scroll")].forEach((pane) => pane.scrollTo({ top: ratio * Math.max(0, pane.scrollHeight - pane.clientHeight), behavior: "smooth" }));
            });
            const synchronizeVerticalScroll = (source, target) => {
                if (state.syncingDiffScroll)
                    return;
                state.syncingDiffScroll = true;
                target.scrollTop = source.scrollTop;
                requestAnimationFrame(() => { state.syncingDiffScroll = false; });
            };
            $("#diff-before-scroll").addEventListener("scroll", (event) => synchronizeVerticalScroll(event.currentTarget, $("#diff-after-scroll")), { passive: true });
            $("#diff-after-scroll").addEventListener("scroll", (event) => synchronizeVerticalScroll(event.currentTarget, $("#diff-before-scroll")), { passive: true });
            $("#diff-editor-text").addEventListener("keydown", (event) => {
                if (state.diffEditor?.busy) {
                    event.preventDefault();
                    return;
                }
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    saveDiffEdit();
                    return;
                }
                if (event.key !== "Tab")
                    return;
                event.preventDefault();
                const input = event.currentTarget;
                input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end");
                input.dispatchEvent(new Event("input"));
            });
        }
        state.diffNavigation?.invalidate();
        state.diffEditor = { repositoryId: repository.id, repositoryName: repository.name, file, staged, snapshot: fileSnapshot, revert: result.revert, changes: result.changes || [], busy: false, beforeContent: result.beforeContent, afterContent: result.afterContent, rows: parsed.rows };
        $("#diff-navigation-status").textContent = "Cmd/Ctrl-click a symbol to open its definition in the current working file. Deleted or changed historical lines are not guessed.";
        $("#diff-navigation-status").dataset.kind = "";
        $("#diff-file").textContent = file;
        $("#diff-scope").textContent = `${repository.name} · ${staged ? "staged change" : "local change"}`;
        $("#diff-before-label").textContent = staged ? "HEAD" : "Staged index";
        $("#diff-after-label").textContent = staged ? "Staged index" : "Working tree";
        $("#diff-additions").textContent = `+${parsed.additions}`;
        $("#diff-deletions").textContent = `−${parsed.deletions}`;
        $("#diff-before-content").innerHTML = renderDiffSide(parsed, "before", [], false, file);
        $("#diff-after-content").innerHTML = renderDiffSide(parsed, "after", result.changes, staged, file);
        const longestCodeLine = (side) => parsed.rows.reduce((longest, row) => Math.max(longest, String(side === "before" ? row.oldText || "" : row.newText || "").replace(/\t/g, "    ").length), 0);
        $("#diff-before-content").style.setProperty("--diff-code-width", `${Math.max(420, Math.min(4800, longestCodeLine("before") * 7.1 + 28))}px`);
        $("#diff-after-content").style.setProperty("--diff-code-width", `${Math.max(420, Math.min(4800, longestCodeLine("after") * 7.1 + 28))}px`);
        $("#diff-overview-ruler").innerHTML = renderDiffOverview(parsed);
        $("#diff-edit-file").classList.toggle("hidden", !fileSnapshot || fileSnapshot.content.includes("\0"));
        setDiffEditMode(false);
        setDiffBusy(false);
        return showAppDialog("diff-dialog");
    }
    catch (error) {
        toast(error.message, "error");
        return false;
    }
}
async function revertIdeDiffChange(context, changeId, isCurrent, isEditorCurrent = isCurrent) {
    const change = context.changes?.find(item => item.id === changeId);
    if (!change || context.busy || !context.revert?.allowed || !context.revert.revision || !isCurrent())
        return false;
    const id = context.repositoryId;
    if (state.gitActionRepositories.has(id)) {
        toast("A Git operation is already running for this repository.");
        return false;
    }
    const dirty = () => !context.staged && repositoryIdeBridge.isFileDirty(id, context.file);
    if (dirty()) {
        toast("Save or discard this file's unsaved IDE edits before reverting. Your draft has been kept.", "error");
        return false;
    }
    const location = change.afterCount ? `line ${change.afterStart}${change.afterCount > 1 ? `–${change.afterStart + change.afterCount - 1}` : ""}` : `before line ${change.afterStart}`;
    const explanation = context.staged
        ? "Unstage only this change? Other staged changes and the working file will be kept."
        : "Revert only this change? Other edits and staged changes will be kept.";
    if (!confirm(`${context.file} · ${location}\n\n${explanation}\nArgus keeps a local recovery copy.`))
        return false;
    if (!isCurrent() || dirty() || state.gitActionRepositories.has(id))
        return false;
    const position = repositoryIdeBridge.getNavigationState();
    context.busy = true;
    state.gitActionRepositories.add(id);
    state.gitStatusVersion++;
    try {
        await api(`/api/repositories/${encodeURIComponent(id)}/git/revert`, { method: "POST", body: {
                file: context.file, staged: context.staged, expectedRevision: context.revert.revision, changeId,
            } });
        context.revert = { ...context.revert, allowed: false };
        state.gitStatusVersion++;
        if (!context.staged)
            repositoryIdeBridge.invalidateSavedFile(id, context.file);
        toast(context.staged ? "Change unstaged; working file kept" : "Change reverted; other edits kept");
        try {
            if (isCurrent()) {
                const refreshCurrent = () => isEditorCurrent() && state.activeRepository?.id === id && state.currentView === "repository";
                if (!await showDiff(context.file, context.staged, position || {}, refreshCurrent) && refreshCurrent()) {
                    toast("The change was applied. Reopen the diff to load its updated contents.", "error");
                }
            }
            if (state.activeRepository?.id === id && state.currentView === "repository")
                await refreshActiveRepository();
        }
        catch {
            toast("The change was applied, but the view could not refresh. Reopen the diff to see the latest changes.", "error");
        }
        return { applied: true };
    }
    catch (error) {
        context.revert = { ...context.revert, allowed: false };
        if (!context.staged)
            repositoryIdeBridge.invalidateSavedFile(id, context.file);
        const reason = "Reopen this diff before reverting another change.";
        toast(`${error.message} ${reason}`, "error");
        return { applied: false, invalidated: true, reason };
    }
    finally {
        context.busy = false;
        state.gitActionRepositories.delete(id);
    }
}
function diffEditIsDirty() {
    return Boolean(state.diffEditor?.snapshot && !$("#diff-file-editor")?.classList.contains("hidden") && $("#diff-editor-text").value !== state.diffEditor.snapshot.content);
}
function updateDiffEditorLines() {
    const editor = $("#diff-editor-text");
    if (!editor)
        return;
    const lineCount = editor.value.split("\n").length;
    $("#diff-editor-lines").textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
}
function setDiffEditMode(editing) {
    state.diffNavigation?.invalidate();
    const editorState = state.diffEditor;
    if (editorState?.busy)
        return;
    const canEdit = Boolean(editorState?.snapshot && !editorState.snapshot.content.includes("\0"));
    const active = Boolean(editing && canEdit);
    $("#diff-file-editor").classList.toggle("hidden", !active);
    $("#diff-split-content").classList.toggle("editing", active);
    $("#diff-edit-file").classList.toggle("hidden", active || !canEdit);
    $("#diff-cancel-edit").classList.toggle("hidden", !active);
    $("#diff-save-file").classList.toggle("hidden", !active);
    $("#diff-after-label").textContent = active ? "Editable working file" : editorState?.staged ? "Staged index" : "Working tree";
    if (!active)
        return;
    const editor = $("#diff-editor-text");
    editor.value = editorState.snapshot.content;
    $("#diff-editor-lines").scrollTop = 0;
    updateDiffEditorLines();
    editor.focus();
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
}
function cancelDiffEdit() {
    if (diffEditIsDirty() && !confirm("Discard your unsaved edits to this file?"))
        return;
    setDiffEditMode(false);
}
function closeDiffDialog() {
    if (state.diffEditor?.busy)
        return;
    if (diffEditIsDirty() && !confirm("Close the diff and discard your unsaved edits?"))
        return;
    state.diffNavigation?.invalidate();
    state.diffLoadSequence = (state.diffLoadSequence || 0) + 1;
    $("#diff-dialog").close();
    state.diffEditor = null;
}
async function saveDiffEdit() {
    const editorState = state.diffEditor;
    if (!editorState?.snapshot || editorState.busy)
        return;
    const content = $("#diff-editor-text").value;
    if (content === editorState.snapshot.content) {
        setDiffEditMode(false);
        return toast("No file changes to save");
    }
    const button = $("#diff-save-file");
    setDiffBusy(true);
    button.textContent = "Saving…";
    try {
        await api(`/api/repositories/${editorState.repositoryId}/file`, { method: "PUT", body: { path: editorState.file, content, expectedHash: editorState.snapshot.contentHash } });
        toast(`${editorState.file} saved`);
        if (state.diffEditor !== editorState || state.activeRepository?.id !== editorState.repositoryId)
            return;
        setDiffBusy(false);
        await refreshActiveRepository();
        if (state.diffEditor === editorState && state.activeRepository?.id === editorState.repositoryId)
            await showDiff(editorState.file, false);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        if (state.diffEditor === editorState)
            setDiffBusy(false);
        button.textContent = "Save file";
    }
}
function setDiffBusy(busy) {
    if (busy)
        state.diffNavigation?.invalidate();
    if (state.diffEditor)
        state.diffEditor.busy = busy;
    for (const selector of ["#diff-edit-file", "#diff-cancel-edit", "#diff-save-file", "[data-close-diff]"])
        $(selector).disabled = busy;
    $("#diff-editor-text").readOnly = busy;
    const revert = $("#diff-revert-file");
    const editor = state.diffEditor;
    revert.disabled = busy || !editor?.revert?.allowed || !editor.revert.revision;
    revert.textContent = busy ? "Working…" : editor?.staged ? "Unstage changes" : "Revert changes";
    revert.title = editor?.revert?.allowed
        ? editor.staged ? "Restore this file's index entry from HEAD; keep the working file" : "Restore only this file's unstaged changes from the staged index"
        : editor?.revert?.reason || "Reopen this diff to check whether it can be safely reverted.";
    for (const button of document.querySelectorAll("[data-revert-change]"))
        button.disabled = revert.disabled;
}
async function revertDiffChange(changeId) {
    const editor = state.diffEditor;
    const change = editor?.changes?.find((item) => item.id === changeId);
    if (!editor || editor.busy || !editor.revert?.allowed || !editor.revert.revision || !change)
        return;
    const location = change.afterCount ? `line ${change.afterStart}${change.afterCount > 1 ? `–${change.afterStart + change.afterCount - 1}` : ""}` : `before line ${change.afterStart}`;
    const explanation = editor.staged
        ? "Unstage only this change? Other staged changes and the working file will be kept."
        : "Revert only this change? Other edits and staged changes will be kept.";
    if (!confirm(`${editor.file} · ${location}\n\n${explanation}${diffEditIsDirty() ? "\nYour unsaved editor text will also be discarded." : ""}\nArgus keeps a local recovery copy.`))
        return;
    if (state.diffEditor !== editor || state.activeRepository?.id !== editor.repositoryId)
        return;
    const scroll = ["before", "after"].map((side) => { const pane = $(`#diff-${side}-scroll`); return { top: pane.scrollTop, left: pane.scrollLeft }; });
    setDiffBusy(true);
    try {
        await api(`/api/repositories/${editor.repositoryId}/git/revert`, { method: "POST", body: { file: editor.file, staged: editor.staged, expectedRevision: editor.revert.revision, changeId } });
        toast(editor.staged ? "Change unstaged; working file kept" : "Change reverted; other edits kept");
        editor.revert = { ...editor.revert, allowed: false, reason: "This diff has changed. Reopen it before reverting another change." };
        if (state.diffEditor !== editor || state.activeRepository?.id !== editor.repositoryId)
            return;
        setDiffBusy(false);
        await showDiff(editor.file, editor.staged);
        const current = state.diffEditor;
        if (current !== editor && current?.repositoryId === editor.repositoryId && current.file === editor.file && current.staged === editor.staged) {
            ["before", "after"].forEach((side, index) => { const pane = $(`#diff-${side}-scroll`); pane.scrollTop = scroll[index].top; pane.scrollLeft = scroll[index].left; });
        }
        if (state.activeRepository?.id === editor.repositoryId)
            await refreshActiveRepository();
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        if (state.diffEditor === editor)
            setDiffBusy(false);
    }
}
async function revertDiffChanges() {
    const editor = state.diffEditor;
    if (!editor || editor.busy || !editor.revert?.allowed || !editor.revert.revision)
        return;
    const dirty = diffEditIsDirty();
    const explanation = editor.staged
        ? "Restore this file's staged index entry to HEAD? The working file will be kept unchanged."
        : "Discard this file's unstaged changes and restore it from the staged index? Already-staged changes will be kept.";
    if (!confirm(`${editor.repositoryName} · ${editor.file}\n\n${explanation}${dirty ? "\nYour unsaved editor text will also be discarded." : ""}\n\nOnly this file is affected. Argus keeps a local recovery copy before applying the change.`))
        return;
    if (state.diffEditor !== editor || state.activeRepository?.id !== editor.repositoryId)
        return;
    setDiffBusy(true);
    try {
        await api(`/api/repositories/${editor.repositoryId}/git/revert`, { method: "POST", body: { file: editor.file, staged: editor.staged, expectedRevision: editor.revert.revision } });
        toast(editor.staged ? `${editor.file} unstaged; working file kept` : `${editor.file} reverted; staged changes kept`);
        if (state.diffEditor !== editor)
            return;
        $("#diff-dialog").close();
        state.diffEditor = null;
        state.diffLoadSequence = (state.diffLoadSequence || 0) + 1;
        if (state.activeRepository?.id === editor.repositoryId)
            await refreshActiveRepository();
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        if (state.diffEditor === editor)
            setDiffBusy(false);
    }
}
function renderDiffSide(parsed, side, changes = [], staged = false, file = "") {
    const before = side === "before";
    const controls = new Map();
    if (!before && changes?.length) {
        const oldRows = new Map(), newRows = new Map();
        parsed.rows.forEach((row, index) => {
            if (!["deleted", "added", "changed"].includes(row.type))
                return;
            if (row.oldLine != null)
                oldRows.set(row.oldLine, index);
            if (row.newLine != null)
                newRows.set(row.newLine, index);
        });
        for (const change of changes) {
            const index = change.beforeCount > 0 ? oldRows.get(change.beforeStart) : newRows.get(change.afterStart);
            if (index != null)
                controls.set(index, change);
        }
    }
    return parsed.rows.map((row, index) => {
        if (row.type === "hunk")
            return `<div class="diff-hunk-row"><span>${escapeHtml(row.label)}</span></div>`;
        if (row.type === "message")
            return `<div class="diff-message-row">${escapeHtml(row.label)}</div>`;
        const line = before ? row.oldLine : row.newLine;
        const text = before ? row.oldText : row.newText;
        const changed = before ? ["deleted", "changed"].includes(row.type) : ["added", "changed"].includes(row.type);
        const change = controls.get(index);
        const action = staged ? "Unstage this change" : "Revert this change";
        const control = change ? `<button class="diff-inline-revert" type="button" data-revert-change="${escapeHtml(change.id)}" aria-label="${action} near line ${change.afterStart}" title="${action}; keep other edits" disabled>↶</button>` : "";
        return `<div class="diff-side-row ${row.type}">
      <span class="diff-line-number ${before ? "old-number" : "new-number"}">${control}<span>${line ?? ""}</span></span>
      <code class="diff-code ${before ? "old-code" : "new-code"} ${changed ? before ? "removed" : "inserted" : ""}"${line == null ? "" : ` data-diff-side="${side}" data-diff-line="${line}"`}>${line == null ? '<span class="empty-side"></span>' : renderDiffNavigationCode(text, file)}</code>
    </div>`;
    }).join("");
}
function renderDiffOverview(parsed) {
    const total = Math.max(1, parsed.rows.length - 1);
    return parsed.rows.map((row, index) => {
        if (!["added", "deleted", "changed"].includes(row.type))
            return "";
        const line = row.newLine ?? row.oldLine ?? index + 1;
        return `<span class="diff-overview-marker ${row.type}" style="top:${(index / total) * 100}%" title="${row.type} near line ${line}"></span>`;
    }).join("");
}
async function gitAction(action, payload = {}) {
    const id = state.activeRepository?.id;
    if (!id)
        return;
    if (state.gitActionRepositories.has(id))
        return toast("A Git operation is already running for this repository.");
    state.gitActionRepositories.add(id);
    state.gitStatusVersion += 1;
    setRefreshLoading($("#refresh-git"), true);
    $("#change-list").innerHTML = skeletonRows(5);
    $("#git-history").innerHTML = skeletonRows(5);
    $("#git-branches").innerHTML = skeletonRows(6, true);
    try {
        const result = await api(`/api/repositories/${id}/git/${action}`, { method: "POST", body: payload });
        if (action === "push" && result.pullRequestUrl)
            toastAction("Changes pushed successfully", "Open pull request in Git remote ↗", result.pullRequestUrl);
        else
            toast(result.output?.trim() || `${action[0].toUpperCase()}${action.slice(1)} completed`);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        state.gitActionRepositories.delete(id);
        if (state.activeRepository?.id === id)
            await refreshActiveRepository();
    }
}
function readableAgentOutput(raw) {
    const lines = raw.split("\n").filter(Boolean);
    const readable = [];
    let parsedEvents = 0;
    for (const line of lines) {
        try {
            const value = JSON.parse(line);
            parsedEvents += 1;
            const codexMessage = value.item?.type === "agent_message" ? value.item.text : "";
            const claudeMessage = value.type === "assistant" ? value.message?.content?.map?.((item) => item.type === "text" ? item.text : "").filter(Boolean).join("\n") : "";
            const text = (codexMessage || claudeMessage || (value.type === "result" ? value.result : ""))
                
                .replace(/\n{3,}/g, "\n\n")
                .trim();
            if (text)
                readable.push(text);
        }
        catch { }
    }
    if (readable.length)
        return [...new Set(readable)].at(-1);
    return parsedEvents ? "" : String(raw || "")
}
function agentDisplayText(job) {
    const answer = Object.prototype.hasOwnProperty.call(job, "displayOutput")
        ? String(job.displayOutput ?? "")
        : job.outputFormat === "ndjson" ? "" : readableAgentOutput(job.output || "");
    if (answer)
        return answer;
    if (job.status === "failed")
        return "The agent could not complete this task. Check the AI authentication status and try again.";
    if (job.status === "cancelled")
        return "The task was stopped.";
    if (job.status === "completed")
        return "The task completed without a written response.";
    return "The agent is working…";
}
function isChatAgentJob(job) {
    return Boolean(job?.taskId && !job.systemJob);
}
function jobBelongsToCurrentChat(scope, job) {
    const taskId = activeTaskId(scope);
    if (!taskId || !isChatAgentJob(job) || job.taskId !== taskId)
        return false;
    if (!chatRevisionState.acceptsJob(job, checkpointTasks.get(scope)))
        return false;
    return scope === "global" ? job.repositoryId === "global" : job.repositoryId === state.activeRepository?.id;
}
function runningAgentJob(scope) {
    const job = scope === "global" ? state.globalJob : state.activeJob;
    return jobBelongsToCurrentChat(scope, job) && agentJobIsActive(job) ? job : null;
}
function setComposerActionState(scope, running) {
    const global = scope === "global";
    const button = global ? $("#run-global-agent") : $("#run-agent");
    const queueButton = global ? $("#queue-global-agent-prompt") : $("#queue-agent-prompt");
    if (!button)
        return;
    queueButton?.classList.toggle("hidden", !running);
    button.classList.toggle("is-running", running);
    button.setAttribute("aria-label", running ? "Stop and edit request" : "Send message");
    button.title = running ? "Stop and edit request" : "Send message";
    if (running)
        button.disabled = false;
    else {
        const providerId = global ? $("#global-agent-provider").value : $("#agent-provider").value;
        const runnable = state.providers.some((provider) => provider.id === providerId && providerCanRun(provider));
        const selectionError = modelSelectionError(scope);
        button.disabled = !runnable || Boolean(selectionError) || (global && !state.workspace?.repositories?.length);
        if (selectionError)
            button.title = selectionError;
    }
}
function setComposerPreparingState(scope, preparing, providerName = "AI provider") {
    const global = scope === "global";
    const button = global ? $("#run-global-agent") : $("#run-agent");
    const card = global ? $("#global-agent-output-card") : $("#agent-output-card");
    const status = global ? $("#global-agent-status") : $("#agent-status");
    const output = global ? $("#global-agent-output") : $("#agent-output");
    const queueButton = global ? $("#queue-global-agent-prompt") : $("#queue-agent-prompt");
    queueButton?.classList.add("hidden");
    if (button) {
        button.classList.toggle("is-preparing", preparing);
        button.classList.toggle("is-running", preparing);
        button.disabled = false;
        button.setAttribute("aria-label", preparing ? "Stop and edit request" : "Send message");
        button.title = preparing ? "Stop and edit request" : "Send message";
    }
    if (preparing) {
        card.dataset.composerPreparing = "true";
        card.classList.remove("hidden");
        status.textContent = "Preparing request";
        const message = selectedContextMode(scope) === "history"
            ? `Selecting relevant previous chat context and starting ${providerName}…`
            : `Starting ${providerName} with a light repository-and-Skills prompt…`;
        renderChatContent(output, message);
        scrollConversationToBottom(scope);
    }
}
function composerRepositoryId(scope) {
    return scope === "global" ? "global" : state.activeRepository?.id;
}
function captureComposerContext(scope) {
    const repositoryId = composerRepositoryId(scope);
    const taskId = activeTaskId(scope) || null;
    const key = JSON.stringify([repositoryId, taskId]);
    state.composerDraftEpochs ||= {};
    return { scope, repositoryId, taskId, key, epoch: state.composerDraftEpochs[key] || 0 };
}
function captureComposerUpload(scope) {
    const context = captureComposerContext(scope);
    state.composerUploads ||= new Set();
    state.composerUploads.add(context);
    return context;
}
function adoptComposerDraftTask(submission, taskId) {
    if (submission.taskId || !taskId)
        return;
    const key = JSON.stringify([submission.repositoryId, taskId]);
    const oldKey = submission.key || JSON.stringify([submission.repositoryId, null]);
    state.composerDraftEpochs ||= {};
    state.composerDraftEpochs[key] = Math.max(state.composerDraftEpochs[key] || 0, state.composerDraftEpochs[oldKey] || 0);
    const recoveries = state.composerRecoveries?.[oldKey] || [];
    for (const context of [...(state.composerUploads || []), ...recoveries]) {
        if (context.repositoryId === submission.repositoryId && !context.taskId) {
            context.taskId = taskId;
            context.key = key;
        }
    }
    if (recoveries.length) {
        (state.composerRecoveries[key] ||= []).push(...recoveries);
        delete state.composerRecoveries[oldKey];
    }
}
function composerContextIsCurrent(context) {
    return composerRepositoryId(context.scope) === context.repositoryId
        && (activeTaskId(context.scope) || null) === context.taskId;
}
function composerRecoveries(scope, context = captureComposerContext(scope)) {
    state.composerRecoveries ||= {};
    return state.composerRecoveries[context.key || JSON.stringify([context.repositoryId, context.taskId || null])] ||= [];
}
function keepComposerRecovery(snapshot) {
    const scope = snapshot.scope || (snapshot.repositoryId === "global" ? "global" : "repository");
    const recoveries = composerRecoveries(scope, snapshot);
    if (!recoveries.includes(snapshot))
        recoveries.push(snapshot);
    if (composerContextIsCurrent({ ...snapshot, scope }))
        renderContextTray(scope);
}
function finishComposerAttachment(context, attachment, fallbackDraft = "") {
    const current = composerContextIsCurrent(context)
        && (state.composerDraftEpochs?.[context.key] || 0) === context.epoch;
    if (!current) {
        context.attachments ||= [];
        if (!context.attachments.some(item => item.id === attachment.id))
            context.attachments.push(attachment);
        context.draft ||= fallbackDraft;
        keepComposerRecovery(context);
        return;
    }
    const attachments = scopedAttachments(context.scope);
    if (!attachments.some(item => item.id === attachment.id))
        attachments.push(attachment);
    const textarea = $(context.scope === "global" ? "#global-agent-prompt" : "#agent-prompt");
    if (!textarea.value.trim() && fallbackDraft) {
        textarea.value = fallbackDraft;
        storeComposerDraft(context.scope);
        resizeAgentComposer(textarea);
    }
    renderContextTray(context.scope);
}
function composerSubmission(scope, repositoryId = composerRepositoryId(scope)) {
    const submission = scope === "global" ? state.globalSubmission : state.repositorySubmissions[repositoryId];
    return submission && (submission.taskId || null) === (activeTaskId(scope) || null) ? submission : null;
}
function composerIsSubmitting(scope, repositoryId = composerRepositoryId(scope)) {
    return scope === "global" ? state.globalSubmitting : Boolean(state.repositorySubmitting[repositoryId]);
}
function storeComposerDraft(scope, value) {
    const textarea = scope === "global" ? $("#global-agent-prompt") : $("#agent-prompt");
    const draft = value === undefined ? textarea?.value || "" : value;
    if (scope === "global")
        state.globalDraft = draft;
    else if (state.activeRepository?.id)
        state.repositoryDrafts[state.activeRepository.id] = draft;
}
function restoreScopedComposer(scope) {
    renderModelControls(scope);
    restoreContextMode(scope);
    const textarea = scope === "global" ? $("#global-agent-prompt") : $("#agent-prompt");
    if (!textarea)
        return;
    textarea.value = scope === "global" ? state.globalDraft || "" : state.repositoryDrafts[state.activeRepository?.id] || "";
    resizeAgentComposer(textarea);
    const submission = composerSubmission(scope);
    if (submission)
        setComposerPreparingState(scope, true, submission.providerName);
    else
        setComposerActionState(scope, Boolean(runningAgentJob(scope)));
}
function finishComposerPreparation(scope, { failed = false } = {}) {
    const global = scope === "global";
    const button = global ? $("#run-global-agent") : $("#run-agent");
    const card = global ? $("#global-agent-output-card") : $("#agent-output-card");
    button?.classList.remove("is-preparing");
    button?.classList.remove("is-running");
    if (card?.dataset.composerPreparing === "true") {
        delete card.dataset.composerPreparing;
        if (failed)
            card.classList.add("hidden");
    }
}
function takeComposerDraft(scope) {
    const textarea = scope === "global" ? $("#global-agent-prompt") : $("#agent-prompt");
    const draft = textarea.value;
    const context = captureComposerContext(scope);
    const attachments = scopedAttachments(scope).splice(0);
    state.composerDraftEpochs[context.key] = context.epoch + 1;
    textarea.value = "";
    storeComposerDraft(scope, "");
    resizeAgentComposer(textarea);
    renderContextTray(scope);
    return { ...context, draft, attachments };
}
function restoreComposerDraft(submission) {
    if (!submission || typeof submission.draft !== "string")
        return false;
    const scope = submission.repositoryId === "global" ? "global" : "repository";
    if (composerRepositoryId(scope) !== submission.repositoryId
        || (activeTaskId(scope) || null) !== (submission.taskId || null)) {
        keepComposerRecovery(submission);
        return false;
    }
    const textarea = scope === "global" ? $("#global-agent-prompt") : $("#agent-prompt");
    if (!textarea || textarea.value || scopedAttachments(scope).length) {
        keepComposerRecovery(submission);
        return false;
    }
    textarea.value = submission.draft;
    scopedAttachments(scope).push(...(submission.attachments || []));
    storeComposerDraft(scope, submission.draft);
    resizeAgentComposer(textarea);
    renderContextTray(scope);
    if (state.currentView === (scope === "global" ? "global" : "repository"))
        textarea.focus();
    return true;
}
async function stopAgent(scope) {
    const headers = { "X-Argus-Cancel-Control": scope === "global" ? "global-composer-stop" : "repository-composer-stop" };
    const submission = composerSubmission(scope);
    if (submission) {
        const button = scope === "global" ? $("#run-global-agent") : $("#run-agent");
        button.classList.add("is-stopping");
        submission.cancelled = true;
        try {
            await api(`/api/agents/preparations/${submission.requestId}`, { method: "DELETE", headers });
        }
        catch (error) {
            toast(error.message, "error");
        }
        finally {
            button.classList.remove("is-stopping");
        }
        return;
    }
    const job = runningAgentJob(scope);
    if (!job)
        return;
    const captured = { ...job };
    const button = scope === "global" ? $("#run-global-agent") : $("#run-agent");
    button.classList.add("is-stopping");
    try {
        const stopped = await api(`/api/agents/jobs/${job.id}`, { method: "DELETE", headers });
        if (stopped?.status === "cancelled" || stopped?.stopRequested === true)
            await recoverStoppedPrompt(scope, captured);
        if (scope === "global")
            await pollGlobalAgent();
        else
            await pollAgent();
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        button.classList.remove("is-stopping");
    }
}
async function stopReturnedSubmission(job, submission) {
    if (!submission.cancelled)
        return null;
    try {
        const control = submission.repositoryId === "global" ? "global" : "repository";
        return await api(`/api/agents/jobs/${job.id}`, { method: "DELETE",
            headers: { "X-Argus-Cancel-Control": `${control}-composer-stop` } });
    }
    catch (error) {
        toast(`The request started before cancellation was confirmed. Use Stop again. ${error.message}`, "error");
        return null;
    }
}
function handleComposerAction(scope) {
    if (revisionIsBusy(scope))
        return;
    if (composerIsSubmitting(scope)) {
        if (composerSubmission(scope))
            return stopAgent(scope);
        return toast("Another chat is still preparing a request. Open that chat to stop it, or wait for it to start.");
    }
    return runningAgentJob(scope) ? stopAgent(scope) : scope === "global" ? runGlobalAgent() : runAgent();
}
function handleComposerKeydown(event, scope) {
    if (event.key !== "Enter" || event.isComposing || event.shiftKey)
        return;
    event.preventDefault();
    if (revisionIsBusy(scope))
        return;
    const submitting = composerIsSubmitting(scope);
    if (submitting)
        return;
    if (runningAgentJob(scope)) {
        return queueCurrentPrompt(scope);
    }
    handleComposerAction(scope);
}
function queuedRequestFromComposer(scope, notesCapture = taskPromptNotes.capture(scope)) {
    const global = scope === "global";
    const textarea = global ? $("#global-agent-prompt") : $("#agent-prompt");
    const prompt = textarea.value.trim();
    if (!prompt)
        throw new Error("Describe what you want the agent to do");
    const providerControl = global ? $("#global-agent-provider") : $("#agent-provider");
    const provider = state.providers.find((item) => item.id === providerControl.value);
    if (!provider?.authenticated)
        throw new Error(`${provider?.name || "AI provider"} sign-in is required`);
    if (!providerCanRun(provider))
        throw new Error(providerBlockedMessage(provider));
    const selectionError = modelSelectionError(scope);
    if (selectionError)
        throw new Error(selectionError);
    if (!validateComposerContext(scope))
        return null;
    const taskId = activeTaskId(scope);
    const active = runningAgentJob(scope);
    if (!taskId || !active || active.taskId !== taskId)
        throw new Error("Open the running task before queueing its next prompt.");
    const attachments = scopedAttachments(scope).map((item) => ({ ...item }));
    const request = {
        requestId: crypto.randomUUID(),
        taskId,
        repositoryId: global ? "global" : state.activeRepository.id,
        repositoryIds: global && Array.isArray(window.argusNexusRepositoryIds) ? window.argusNexusRepositoryIds.slice(0, 6) : [],
        providerId: provider.id,
        providerName: provider.name,
        mode: global ? $("#global-agent-mode").value : $("#agent-mode").value,
        modelSettings: selectedModelSettings(scope),
        contextMode: selectedContextMode(scope),
        ...notesCapture.request,
        prompt,
        attachments,
        attachmentIds: attachments.map((item) => item.id),
        createdAt: new Date().toISOString(),
    };
    return request;
}
async function queueCurrentPrompt(scope) {
    if (revisionIsBusy(scope))
        return;
    const taskId = activeTaskId(scope);
    if (state.promptQueueSaves.has(taskId))
        return;
    state.promptQueueSaves.add(taskId);
    let draft;
    try {
        const notesCapture = taskPromptNotes.capture(scope);
        let request = queuedRequestFromComposer(scope, notesCapture);
        if (!request)
            return;
        const fingerprint = JSON.stringify([request.taskId, request.repositoryId, request.repositoryIds, request.providerId, request.mode, request.modelSettings, request.contextMode, request.prompt, request.attachmentIds, request.promptNotes]);
        const retry = state.promptQueueSaveRetries.get(taskId);
        if (retry?.fingerprint === fingerprint)
            request = retry.request;
        else
            state.promptQueueSaveRetries.set(taskId, { fingerprint, request });
        const predecessor = runningAgentJob(scope)?.id;
        draft = takeComposerDraft(scope);
        const saved = await api("/api/prompt-queue", { method: "POST", body: request });
        const acceptedDraft = draft;
        draft = null;
        taskPromptNotes.submitted(notesCapture, request.taskId);
        state.promptQueueSaveRetries.delete(taskId);
        const queue = queuedPrompts(scope, request.taskId);
        const alreadyStarted = saved.status === "started";
        if (!alreadyStarted && !queue.some((item) => item.requestId === saved.requestId))
            queue.push(saved);
        state.promptQueuesLoaded.add(request.taskId);
        if (composerContextIsCurrent(acceptedDraft)) {
            if (!alreadyStarted)
                appendOptimisticUserMessage(scope, { ...saved, queued: true, queuePosition: queue.length });
        }
        toast(alreadyStarted ? "This saved request already started. Check the chat for its response." : `Prompt queued · ${queue.length} waiting`);
        if (!alreadyStarted)
            processPromptQueue(scope, request.taskId, predecessor);
    }
    catch (error) {
        if (draft)
            restoreComposerDraft(draft);
        toast(error.message, "error");
    }
    finally {
        state.promptQueueSaves.delete(taskId);
    }
}
async function waitForQueuedPredecessor(jobId) {
    let current = jobId;
    while (current) {
        const job = await api(`/api/agents/jobs/${current}`);
        if (!agentJobIsActive(job))
            return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
function holdQueuedPrompt(requestId) {
    if (state.promptQueueHolds.has(requestId))
        return null;
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    const hold = { promise, release: () => { if (state.promptQueueHolds.get(requestId) === hold)
            state.promptQueueHolds.delete(requestId); release(); } };
    state.promptQueueHolds.set(requestId, hold);
    return hold;
}
function refreshQueuedSteeringControls(scope) {
    const conversation = scope === "global" ? $("#global-agent-conversation") : $("#agent-conversation");
    const job = runningAgentJob(scope);
    for (const control of conversation?.querySelectorAll("[data-queued-steering]") || []) {
        const taskId = control.dataset.queueTask, requestId = control.dataset.queuedSteering;
        const request = queuedPrompts(scope, taskId).find(item => item.requestId === requestId);
        const pending = queuedPromptSteering.isPending(requestId);
        const markup = request ? queuedSteerButtonMarkup(scope, taskId, request, { job, pending }) : "";
        if (control.steeringMarkup !== markup) {
            renderChatMarkup(control, markup);
            control.steeringMarkup = markup;
        }
        for (const button of control.parentElement.querySelectorAll("[data-edit-queued], [data-discard-queued]"))
            button.disabled = pending;
    }
}
const queuedPromptSteering = createQueuedPromptSteering({
    api: (...args) => api(...args), getQueue: queuedPrompts, getJob: runningAgentJob, hold: holdQueuedPrompt,
    isCurrent: (scope, taskId, repositoryId) => activeTaskId(scope) === taskId && (scope === "global" || state.activeRepository?.id === repositoryId),
    onChange: ({ scope, taskId, task, refreshConversation }) => {
        const current = task || checkpointTasks.get(scope);
        if (refreshConversation && current?.id === taskId)
            renderTaskConversation(scope, current);
        refreshQueuedSteeringControls(scope);
    },
    onSuccess: message => toast(message), onError: message => toast(message, "error"),
});
async function saveQueuedPromptEdit({ scope, request, prompt, promptNotes }) {
    if (activeTaskId(scope) !== request.taskId || (scope !== "global" && state.activeRepository?.id !== request.repositoryId))
        throw new Error("Return to the original chat before saving this queued message.");
    let saved;
    try {
        saved = await api(`/api/prompt-queue/${encodeURIComponent(request.requestId)}`, {
            method: "PATCH", body: { taskId: request.taskId, expectedPrompt: request.prompt, prompt, ...(promptNotes ? { promptNotes, expectedPromptNotes: request.promptNotes || [] } : {}) },
        });
    }
    catch (error) {
        const latest = await api(`/api/prompt-queue?taskId=${encodeURIComponent(request.taskId)}`, { dedupe: false, cache: "no-store" }).catch(() => null);
        const observed = latest?.find((item) => item.requestId === request.requestId);
        const unchangedSettings = observed && ["taskId", "scope", "repositoryId", "repositoryIds", "providerId", "mode", "modelSettings", "contextMode", "attachmentIds"].every((key) => JSON.stringify(observed[key]) === JSON.stringify(request[key]));
        if (observed?.status !== "queued" || observed.prompt !== prompt || !unchangedSettings || JSON.stringify(observed.promptNotes || []) !== JSON.stringify(promptNotes ?? request.promptNotes ?? []))
            throw error;
        saved = observed;
    }
    const current = queuedPrompts(scope, request.taskId).find((item) => item.requestId === request.requestId);
    if (current)
        Object.assign(current, saved);
    try {
        const task = await api(`/api/ai-tasks/${encodeURIComponent(request.taskId)}`);
        if (activeTaskId(scope) === request.taskId)
            renderTaskConversation(scope, task);
    }
    catch {
        toast("Queued message saved. Refresh the chat to see the update.");
        return;
    }
    toast("Queued message updated");
}
const queuedPromptEditor = createQueuedPromptEditor({ document,
    createNoteFields: (host) => createPromptNoteFields(document, host),
    load: async ({ taskId, requestId }) => (await api(`/api/prompt-queue?taskId=${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" })).find((item) => item.requestId === requestId),
    save: saveQueuedPromptEdit,
    beforeOpen: ({ scope, taskId, request }) => {
        if (activeTaskId(scope) !== taskId || (scope !== "global" && state.activeRepository?.id !== request.repositoryId))
            throw new Error("The active chat changed. Open Edit again in the original chat.");
        return closeOpenDialogs();
    },
});
async function openQueuedPromptEdit(scope, taskId, requestId, trigger) {
    if (activeTaskId(scope) !== taskId)
        return;
    const hold = holdQueuedPrompt(requestId);
    if (!hold)
        return;
    try {
        const session = await queuedPromptEditor.open({ scope, taskId, requestId, trigger });
        await session?.closed;
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        hold.release();
    }
}
async function handleSavedQueueAction(scope, taskId, requestId) {
    if (activeTaskId(scope) !== taskId)
        return;
    state.promptQueueResumes ||= new Set();
    if (!requestId && state.promptQueueResumes.has(taskId))
        return;
    const queue = queuedPrompts(scope, taskId);
    const hold = requestId ? holdQueuedPrompt(requestId) : null;
    if (requestId && !hold)
        return;
    try {
        if (requestId) {
            if (!confirm("Remove this saved request from the queue? This does not stop a response that already started."))
                return;
            await api(`/api/prompt-queue/${encodeURIComponent(requestId)}`, { method: "DELETE" });
            const index = queue.findIndex((item) => item.requestId === requestId);
            if (index >= 0)
                queue.splice(index, 1);
            toast("Message removed from the queue");
        }
        else {
            state.promptQueueResumes.add(taskId);
            if (agentQuestionCards.isSending(taskId))
                throw new Error("Wait for the question reply or cancellation to finish before resuming this queue.");
            if (queue.some((item) => item.status !== "queued"))
                throw new Error("Check the interrupted request in chat, then remove it from the queue before resuming the remaining requests.");
            const latest = await api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" });
            if (latestTaskQuestion(latest)?.question.source === "structured")
                throw new Error("Answer Argus’s question or cancel this request first. Your queued messages are kept and can be resumed afterward.");
            if (agentQuestionCards.isSending(taskId))
                throw new Error("Wait for the question reply or cancellation to finish before resuming this queue.");
            const saved = await api("/api/prompt-queue/resume", { method: "POST", body: { taskId } });
            if (!Array.isArray(saved))
                throw new Error("The saved queue could not be refreshed. Your queued requests remain paused.");
            queue.splice(0, queue.length, ...saved.map((item) => ({ ...item, recovered: Boolean(item.pauseReason) || item.status !== "queued" })));
            state.promptQueuesLoaded.add(taskId);
            const jobs = scope === "global" ? state.globalJobs : state.repositoryJobs;
            processPromptQueue(scope, taskId, jobs.find((job) => job.taskId === taskId && agentJobIsActive(job))?.id);
        }
        const task = await api(`/api/ai-tasks/${taskId}`);
        if (activeTaskId(scope) === taskId)
            renderTaskConversation(scope, task);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        hold?.release();
        if (!requestId)
            state.promptQueueResumes.delete(taskId);
    }
}
async function startQueuedPrompt(scope, request) {
    const body = {
        requestId: request.requestId,
        taskId: request.taskId,
        ...(Number.isSafeInteger(request.expectedRevisionCount) ? { expectedRevisionCount: request.expectedRevisionCount } : {}),
        provider: request.providerId,
        mode: request.mode,
        contextMode: request.contextMode,
        ...request.modelSettings,
        prompt: request.prompt,
        ...(Array.isArray(request.promptNotes) ? { promptNotes: request.promptNotes } : {}),
        attachmentIds: request.attachmentIds,
        ...(request.dispatchToken ? { queueRequestId: request.requestId, queueDispatchToken: request.dispatchToken } : {}),
    };
    if (scope === "global") {
        body.scope = "global";
        body.repositoryIds = request.repositoryIds;
    }
    else
        body.repositoryId = request.repositoryId;
    const job = await api("/api/agents/run", { method: "POST", body });
    const repositoryVisible = scope === "global" || state.activeRepository?.id === request.repositoryId;
    const taskVisible = repositoryVisible && activeTaskId(scope) === request.taskId;
    const jobs = scope === "global" ? state.globalJobs : repositoryVisible ? state.repositoryJobs : null;
    if (jobs && !jobs.some((item) => item.id === job.id))
        jobs.unshift(job);
    if (taskVisible) {
        if (scope === "global")
            showGlobalJob(job);
        else
            showRepositoryJob(job);
        try {
            await refreshTasks(scope);
            await selectTask(scope, request.taskId);
        }
        catch (error) {
            toast(`Response started; chat refresh failed: ${error.message}`, "error");
        }
    }
    else if (jobs)
        renderAgentTabs(scope);
    return job;
}
async function processPromptQueue(scope, taskId, predecessorJobId) {
    const key = `${scope}:${taskId}`;
    if (state.promptQueueProcessors.has(key))
        return;
    state.promptQueueProcessors.add(key);
    let previousJobId = predecessorJobId;
    try {
        const queue = queuedPrompts(scope, taskId);
        while (queue.length) {
            let request = queue[0];
            if (request.recovered || request.pauseReason || request.status !== "queued")
                break;
            try {
                await waitForQueuedPredecessor(previousJobId);
                request = queue[0];
                if (!request || request.recovered || request.pauseReason || request.status !== "queued")
                    break;
                if (agentQuestionCards.isSending(taskId)) {
                    for (const item of queue) {
                        item.recovered = true;
                        item.pauseReason ||= "question-action";
                    }
                    break;
                }
                const hold = state.promptQueueHolds.get(request.requestId);
                if (hold) {
                    await hold.promise;
                    continue;
                }
                const latestTask = await api(`/api/ai-tasks/${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" });
                if (latestTaskQuestion(latestTask)?.question.source === "structured") {
                    for (const item of queue) {
                        item.recovered = true;
                        item.pauseReason = "question";
                    }
                    toast("Queue paused for Argus’s question. Answer first, then resume when ready; your queued messages are kept.");
                    break;
                }
                if (agentQuestionCards.isSending(taskId)) {
                    for (const item of queue) {
                        item.recovered = true;
                        item.pauseReason ||= "question-action";
                    }
                    break;
                }
                if (queue[0] !== request || request.recovered || request.pauseReason || request.status !== "queued" || state.promptQueueHolds.has(request.requestId))
                    continue;
                const claimed = await api(`/api/prompt-queue/${encodeURIComponent(request.requestId)}/claim`, { method: "POST", body: {} });
                if (agentQuestionCards.isSending(taskId) || request.recovered || request.pauseReason || queue[0] !== request) {
                    for (const item of queue) {
                        item.recovered = true;
                        item.pauseReason ||= "question-action";
                    }
                    while (agentQuestionCards.isSending(taskId))
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    if (queue.find((item) => item.requestId === request.requestId)?.pauseReason !== "question-cancelled") {
                        await api(`/api/prompt-queue/${encodeURIComponent(request.requestId)}/interrupted`, {
                            method: "POST", body: { dispatchToken: claimed.dispatchToken, error: "Dispatch stopped while handling an agent question. Check this chat before resending." },
                        }).catch(() => { });
                    }
                    const saved = await api(`/api/prompt-queue?taskId=${encodeURIComponent(taskId)}`, { dedupe: false, cache: "no-store" }).catch(() => null);
                    if (saved)
                        queue.splice(0, queue.length, ...saved.map((item) => ({ ...item, recovered: true })));
                    else if (queue.includes(request))
                        Object.assign(request, { status: "interrupted", recovered: true });
                    break;
                }
                Object.assign(request, claimed);
                const job = await startQueuedPrompt(scope, request);
                await api(`/api/prompt-queue/${encodeURIComponent(request.requestId)}`, { method: "DELETE" }).catch(() => { });
                queue.shift();
                previousJobId = job.id;
                const taskVisible = scope === "global" || state.activeRepository?.id === request.repositoryId;
                if (taskVisible && activeTaskId(scope) === taskId) {
                    const task = await api(`/api/ai-tasks/${taskId}`).catch(() => null);
                    if (task)
                        renderTaskConversation(scope, task);
                }
            }
            catch (error) {
                if (!request)
                    break;
                Object.assign(request, { status: "interrupted", recovered: true, error: error.message });
                if (request.dispatchToken)
                    await api(`/api/prompt-queue/${encodeURIComponent(request.requestId)}/interrupted`, { method: "POST", body: { error: error.message, dispatchToken: request.dispatchToken } }).catch(() => { });
                else {
                    const saved = await api(`/api/prompt-queue?taskId=${encodeURIComponent(taskId)}`).catch(() => null);
                    if (saved)
                        queue.splice(0, queue.length, ...saved.map((item) => ({ ...item, recovered: true })));
                }
                toast(`Queued request kept for recovery: ${error.message}`, "error");
                break;
            }
        }
    }
    finally {
        state.promptQueueProcessors.delete(key);
        if (activeTaskId(scope) === taskId) {
            const task = await api(`/api/ai-tasks/${taskId}`).catch(() => null);
            if (task)
                renderTaskConversation(scope, task);
        }
    }
}
async function runAgent() {
    if (revisionIsBusy("repository"))
        return;
    if (await retryRevisionFromComposer("repository"))
        return;
    if (checkpointTasks.get("repository")?.codeDiscussionTask === true)
        return repositoryIdeBridge.openCodeDiscussions(state.activeRepository?.id);
    const prompt = $("#agent-prompt").value.trim();
    if (!prompt)
        return toast("Describe what you want the agent to do", "error");
    const provider = state.providers.find((item) => item.id === $("#agent-provider").value);
    const modelSettings = selectedModelSettings("repository");
    if (!provider?.authenticated)
        return toast(`${provider?.name || "AI provider"} sign-in is required`, "error");
    if (!providerCanRun(provider))
        return toast(providerBlockedMessage(provider), "error");
    const selectionError = modelSelectionError("repository");
    if (selectionError)
        return toast(selectionError, "error");
    const repositoryId = state.activeRepository.id;
    if (!validateComposerContext("repository"))
        return;
    const attachmentIds = scopedAttachments("repository").map((item) => item.id);
    const notesCapture = taskPromptNotes.capture("repository");
    const draft = takeComposerDraft("repository");
    const contextMode = selectedContextMode("repository");
    const submission = { ...draft, requestId: crypto.randomUUID(), prompt, providerName: provider.name, contextMode, taskId: activeTaskId("repository") || null, repositoryId, createdAt: new Date().toISOString(), startedAt: Date.now(), cancelled: false };
    submission.promptNotes = notesCapture.request.promptNotes;
    submission.previousMessageIds = (checkpointTasks.get("repository")?.messages || []).map(message => message.id);
    submission.modelSelectionKey = currentModelSelectionKey("repository");
    submission.modelDraftEpoch = modelDraftEpochs.get(submission.modelSelectionKey) || 0;
    state.repositorySubmissions[repositoryId] = submission;
    state.repositorySubmitting[repositoryId] = true;
    appendOptimisticUserMessage("repository", submission);
    setComposerPreparingState("repository", true, provider.name);
    let job;
    try {
        job = await api("/api/agents/run", { method: "POST", body: { requestId: submission.requestId, taskId: submission.taskId || undefined, repositoryId, provider: $("#agent-provider").value, mode: $("#agent-mode").value, contextMode, ...modelSettings, ...notesCapture.request, prompt, attachmentIds } });
    }
    catch (error) {
        const repositoryVisible = state.activeRepository?.id === repositoryId && (activeTaskId("repository") || null) === submission.taskId;
        if (repositoryVisible)
            finishComposerPreparation("repository", { failed: true });
        delete state.repositorySubmissions[repositoryId];
        delete state.repositorySubmitting[repositoryId];
        if (submission.cancelled && repositoryVisible) {
            await refreshTasks("repository", false, { preserveSelection: true }).catch(() => { });
            const stoppedDraft = { ...submission, kind: "preparation" };
            if (!await recoverStoppedPrompt("repository", stoppedDraft))
                keepComposerRecovery(stoppedDraft);
        }
        else
            restoreComposerDraft(submission);
        if (repositoryVisible)
            setComposerActionState("repository", false);
        return submission.cancelled ? toast("Response stopped") : toast(error.message, "error");
    }
    adoptComposerDraftTask(submission, job.taskId);
    let stopped = await stopReturnedSubmission(job, submission);
    if (state.activeRepository?.id === repositoryId && (activeTaskId("repository") || null) === submission.taskId)
        finishComposerPreparation("repository");
    await retainStartedTaskSelection("repository", job.taskId, submission, { provider: provider.id, ...modelSettings });
    if (!stopped && submission.cancelled)
        stopped = await stopReturnedSubmission(job, submission);
    taskPromptNotes.submitted(notesCapture, job.taskId);
    delete state.repositorySubmissions[repositoryId];
    delete state.repositorySubmitting[repositoryId];
    if (state.activeRepository?.id !== repositoryId)
        return;
    state.repositoryJobs.unshift(job);
    if ((activeTaskId("repository") || null) !== submission.taskId || state.currentView !== "repository")
        return;
    state.activeJob = job;
    setComposerActionState("repository", agentJobIsActive(job));
    try {
        state.activeTaskByRepository[repositoryId] = state.activeJob.taskId;
        syncViewUrl("repository", true);
        renderContextTray("repository");
        await refreshTasks("repository");
        await selectTask("repository", state.activeJob.taskId);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        delete state.repositorySubmitting[repositoryId];
    }
    if (stopped?.status === "cancelled" || stopped?.stopRequested === true)
        await recoverStoppedPrompt("repository", job);
}
async function openGlobalCodex({ isCurrent = () => true } = {}) {
    if (!isCurrent() || switchPrimaryView("global") === false)
        return;
    const knownJobIds = new Set([...state.globalJobs.map(job => job.id), state.globalJob?.id]);
    try {
        const [jobs, tasks] = await Promise.all([api("/api/agents/jobs?repositoryId=global"), api("/api/ai-tasks?scope=global&repositoryId=global")]);
        if (!isCurrent())
            return;
        state.globalJobs = reconcileAgentJobs(jobs, state.globalJobs, state.globalJob, "global", knownJobIds);
        state.globalTasks = tasks;
        state.globalJobs = state.globalJobs.filter(isChatAgentJob);
        const preparingDraft = state.globalSubmitting && state.globalSubmission && !state.globalSubmission.taskId && !state.activeGlobalTaskId;
        const selectedLiveTask = state.globalJobs.some(job => job.taskId === state.activeGlobalTaskId && agentJobIsActive(job));
        if (!preparingDraft && !selectedLiveTask && !state.globalTasks.some((task) => task.id === state.activeGlobalTaskId))
            state.activeGlobalTaskId = state.globalTasks[0]?.id || null;
        renderTaskList("global");
        renderAgentTabs("global");
        const running = state.globalJobs.find((job) => jobBelongsToCurrentChat("global", job) && agentJobIsActive(job));
        if (running?.taskId)
            await selectTask("global", running.taskId, { isCurrent });
        else if (running)
            showGlobalJob(running);
        else if (state.activeGlobalTaskId)
            await selectTask("global", state.activeGlobalTaskId, { isCurrent });
        else {
            state.globalJob = null;
            clearInterval(state.globalJobTimer);
            $("#global-agent-output-card").classList.add("hidden");
            renderModelControls("global");
            renderTaskConversation("global", { messages: [] });
            const submission = composerSubmission("global");
            if (submission)
                setComposerPreparingState("global", true, submission.providerName);
            else
                setComposerActionState("global", false);
        }
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function backgroundJobIsActive(job) {
    return ["queued", "running", "paused"].includes(job.status);
}
function backgroundJobStatusLabel(job = {}) {
    if (job.status === "completed")
        return "Complete · 100%";
    if (job.status === "completed-with-warning")
        return "Offboarded · backup warning";
    if (job.status === "completed-with-errors")
        return `Completed with issues · ${job.percent || 0}%`;
    if (job.status === "cancelled")
        return `Cancelled · ${job.percent || 0}%`;
    if (job.status === "failed")
        return `Terminated · ${job.percent || 0}%`;
    if (job.status === "interrupted")
        return `Interrupted · ${job.percent || 0}%`;
    if (job.status === "paused")
        return `Paused · ${job.percent || 0}%`;
    return `${job.percent || 0}%`;
}
const BACKGROUND_ACTIVITY_POSITION_KEY = "argus-background-activity-position-v1";
function savedBackgroundActivityPosition() {
    try {
        const position = JSON.parse(localStorage.getItem(BACKGROUND_ACTIVITY_POSITION_KEY) || "null");
        return Number.isFinite(position?.x) && Number.isFinite(position?.y) ? position : null;
    }
    catch {
        return null;
    }
}
function positionBackgroundActivitySurface(element, position = savedBackgroundActivityPosition()) {
    if (!element || !position || element.classList.contains("hidden"))
        return;
    const margin = 10;
    const maxLeft = Math.max(margin, window.innerWidth - element.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - element.offsetHeight - margin);
    element.style.left = `${Math.round(margin + Math.max(0, Math.min(1, position.x)) * (maxLeft - margin))}px`;
    element.style.top = `${Math.round(margin + Math.max(0, Math.min(1, position.y)) * (maxTop - margin))}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
}
function installBackgroundActivityDrag(element, handle, { ignoreSelector = "" } = {}) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || (ignoreSelector && event.target.closest(ignoreSelector)))
            return;
        const bounds = element.getBoundingClientRect();
        drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: bounds.left, top: bounds.top, moved: false };
        handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.pointerId)
            return;
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(deltaX, deltaY) < 4)
            return;
        drag.moved = true;
        element.classList.add("is-dragging");
        const margin = 10;
        const left = Math.max(margin, Math.min(window.innerWidth - element.offsetWidth - margin, drag.left + deltaX));
        const top = Math.max(margin, Math.min(window.innerHeight - element.offsetHeight - margin, drag.top + deltaY));
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        element.style.right = "auto";
        element.style.bottom = "auto";
        event.preventDefault();
    });
    const finish = (event) => {
        if (!drag || event.pointerId !== drag.pointerId)
            return;
        if (drag.moved) {
            const bounds = element.getBoundingClientRect();
            const availableX = Math.max(1, window.innerWidth - element.offsetWidth - 20);
            const availableY = Math.max(1, window.innerHeight - element.offsetHeight - 20);
            localStorage.setItem(BACKGROUND_ACTIVITY_POSITION_KEY, JSON.stringify({ x: Math.max(0, Math.min(1, (bounds.left - 10) / availableX)), y: Math.max(0, Math.min(1, (bounds.top - 10) / availableY)) }));
            element.dataset.dragClick = "true";
            setTimeout(() => delete element.dataset.dragClick, 0);
        }
        element.classList.remove("is-dragging");
        if (handle.hasPointerCapture(event.pointerId))
            handle.releasePointerCapture(event.pointerId);
        drag = null;
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
}
function installBackgroundActivityDragging() {
    const panel = $("#background-jobs-panel");
    const reopen = $("#background-jobs-reopen");
    installBackgroundActivityDrag(panel, panel.querySelector(":scope > header"), { ignoreSelector: "button" });
    installBackgroundActivityDrag(reopen, reopen);
    const reposition = () => {
        positionBackgroundActivitySurface(panel);
        positionBackgroundActivitySurface(reopen);
    };
    window.addEventListener("resize", reposition, { passive: true });
    requestAnimationFrame(reposition);
}
function backgroundJobRepositoryMarkup(job) {
    const items = Array.isArray(job.items) ? job.items : [];
    const rows = items.flatMap((item) => {
        const name = typeof item?.name === "string" && item.name.trim() ? item.name.trim()
            : typeof item?.repositoryId === "string" ? item.repositoryId.trim() : "";
        if (!name)
            return [];
        let status = item.status;
        if (["queued", "running", "paused"].includes(status)) {
            if (job.status === "cancelled")
                status = "cancelled";
            else if (!backgroundJobIsActive(job))
                status = status === "queued" ? "not-started" : "interrupted";
            else if (job.status === "paused" && status !== "queued")
                status = "paused";
        }
        const labels = { completed: "Ready", running: "Preparing", queued: "Queued", paused: "Paused", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", "not-started": "Not started" };
        const label = Object.hasOwn(labels, status) ? labels[status] : "Status unavailable";
        const tone = status === "completed" ? "ready" : status === "failed" ? "failed" : status === "running" ? "preparing" : "pending";
        return [`<li><span class="background-job-repository-name">${escapeHtml(name)}</span><span class="background-job-repository-status ${tone}">${label}</span></li>`];
    });
    return rows.length ? `<section class="background-job-repositories" aria-label="Repository AI kits"><h4>Repositories</h4><ul>${rows.join("")}</ul></section>` : "";
}
function backgroundJobMarkup(job) {
    const active = backgroundJobIsActive(job);
    const terminated = job.status === "failed";
    const notStarted = Math.max(0, Number(job.total || 0) - Number(job.completed || 0) - Number(job.failed || 0));
    const detail = job.error || job.message || (active ? "Working in the background…" : "Background operation finished.");
    const current = active
        ? job.status === "paused" ? (job.currentItem ? `Paused at ${job.currentItem}` : "Paused by you") : job.currentItem ? `Preparing ${job.currentItem}` : job.total ? `${job.completed || 0} of ${job.total} complete` : "Detecting repositories"
        : terminated ? `Terminated after ${job.completed || 0} of ${job.total || 0} · ${job.failed || 1} failed${notStarted ? ` · ${notStarted} not started` : ""}` : job.status === "interrupted" ? "Interrupted before completion" : job.status === "cancelled" ? "Cancelled by you" : job.total ? `${job.completed || 0} of ${job.total} complete${job.failed ? ` · ${job.failed} failed` : ""}` : "Finished";
    const progress = `<div class="background-job-progress"><i style="width:${Number(job.percent || 0)}%"></i></div>`;
    const logs = Array.isArray(job.logs) ? job.logs : [];
    const defaultLogsOpen = Boolean(job.failed) || ["failed", "completed-with-errors", "completed-with-warning"].includes(job.status);
    const logsOpen = state.backgroundJobLogExpanded.has(job.id) ? state.backgroundJobLogExpanded.get(job.id) : defaultLogsOpen;
    const logMarkup = logs.length ? `<details class="background-job-logs" data-background-job-logs="${escapeHtml(job.id)}" ${logsOpen ? "open" : ""}>
    <summary>${active ? "View live logs" : "View logs"} <span>${logs.length}</span></summary>
    <div>${logs.map((entry) => {
        const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
        const scope = [entry.repository, entry.stage].filter(Boolean).join(" · ");
        const duration = Number.isFinite(Number(entry.durationMillis)) ? ` · ${Math.max(0, Math.round(Number(entry.durationMillis) / 1000))}s` : "";
        return `<article class="${escapeHtml(entry.level || "info")}"><header><time>${escapeHtml(time)}</time><strong>${escapeHtml(scope || "Background job")}</strong><span>${escapeHtml(duration)}</span></header><pre>${escapeHtml(entry.message || "")}</pre></article>`;
    }).join("")}</div>
  </details>` : "";
    const pauseAction = active && job.type !== "repository-offboarding" ? `<button type="button" data-background-job-pause="${escapeHtml(job.id)}" aria-label="${job.status === "paused" ? "Resume" : "Pause"} ${escapeHtml(job.title)}" title="${job.status === "paused" ? "Resume from the same point" : "Pause"}">${job.status === "paused" ? "▶" : "Ⅱ"}</button>` : "";
    return `<article data-activity-key="${escapeHtml(job.id)}" class="background-job-card ${["failed", "interrupted", "completed-with-errors"].includes(job.status) ? "failed" : job.status === "completed-with-warning" ? "warning" : ""}" data-job-id="${escapeHtml(job.id)}" data-job-status="${escapeHtml(job.status)}">
    <header><strong>${escapeHtml(job.title)}</strong><div class="background-job-card-actions"><span>${escapeHtml(backgroundJobStatusLabel(job))}</span>${pauseAction}<button type="button" data-background-job-close="${escapeHtml(job.id)}" aria-label="${active ? "Stop" : "Dismiss"} ${escapeHtml(job.title)}" title="${active ? "Stop process" : "Dismiss"}">×</button></div></header>
    <p>${escapeHtml(detail)}</p>
    ${progress}
    <div class="background-job-meta"><span>${escapeHtml(current)}</span><span>${escapeHtml(job.type === "repository-onboarding" ? "Onboarding" : job.type === "repository-offboarding" ? "Offboarding" : job.type === "backup-sync" ? "Backup" : "AI kit")}</span></div>
    ${backgroundJobRepositoryMarkup(job)}
    ${logMarkup}
  </article>`;
}
function renderBackgroundJobs() {
    state.backgroundJobs = ownerVisibleBackgroundJobs(state.backgroundJobs);
    const active = state.backgroundJobs.filter(backgroundJobIsActive);
    const pausable = active.filter((job) => job.type !== "repository-offboarding");
    const allPaused = Boolean(pausable.length) && pausable.every((job) => job.status === "paused");
    const recent = state.backgroundJobs.filter((job) => !backgroundJobIsActive(job) && !state.dismissedBackgroundJobs.has(job.id)).slice(0, 20);
    const history = [...active, ...recent];
    if (history.length <= 2)
        state.backgroundJobsExpanded = false;
    const visible = state.backgroundJobsExpanded ? history : history.slice(0, 2);
    const panel = $("#background-jobs-panel");
    const reopen = $("#background-jobs-reopen");
    const list = $("#background-jobs-list");
    const listScrollState = captureLiveScroll(list);
    const logScrollStates = new Map([...list.querySelectorAll("[data-background-job-logs]")].map((details) => [
        details.dataset.backgroundJobLogs,
        captureLiveScroll(details.querySelector(":scope > div")),
    ]));
    panel.classList.toggle("hidden", !history.length || state.backgroundJobsMinimized);
    reopen.classList.toggle("hidden", !history.length || !state.backgroundJobsMinimized);
    requestAnimationFrame(() => positionBackgroundActivitySurface(state.backgroundJobsMinimized ? reopen : panel));
    reopen.classList.toggle("completed", !active.length);
    setTextIfChanged(reopen.querySelector("small"), active.length ? allPaused ? `${pausable.length} paused` : `${active.length} running` : backgroundJobStatusLabel(recent[0]));
    panel.classList.toggle("completed", !active.length);
    panel.classList.toggle("paused", allPaused);
    reopen.classList.toggle("paused", allPaused);
    const pauseAll = $("#background-jobs-pause");
    pauseAll.classList.toggle("hidden", !pausable.length);
    setTextIfChanged(pauseAll, allPaused ? "▶" : "Ⅱ");
    pauseAll.title = allPaused ? "Resume all" : "Pause all";
    pauseAll.setAttribute("aria-label", allPaused ? "Resume all background activity" : "Pause all background activity");
    const latestNeedsAttention = !active.length && ["failed", "interrupted", "completed-with-errors"].includes(recent[0]?.status);
    const latestHasWarning = !active.length && recent[0]?.status === "completed-with-warning";
    panel.classList.toggle("attention", latestNeedsAttention);
    reopen.classList.toggle("attention", latestNeedsAttention);
    panel.classList.toggle("warning", latestHasWarning);
    reopen.classList.toggle("warning", latestHasWarning);
    panel.classList.toggle("history-expanded", state.backgroundJobsExpanded);
    const markupSignature = JSON.stringify([visible, [...state.backgroundJobLogExpanded]]);
    if (state.backgroundJobsMarkupSignature !== markupSignature) {
        state.backgroundJobsMarkupSignature = markupSignature;
        state.backgroundJobsMarkup = visible.map(backgroundJobMarkup).join("");
    }
    renderActivityMarkup(list, state.backgroundJobsMarkup);
    restoreLiveScroll(list, listScrollState);
    list.querySelectorAll("[data-background-job-logs]").forEach((details) => {
        restoreLiveScroll(details.querySelector(":scope > div"), logScrollStates.get(details.dataset.backgroundJobLogs));
    });
    const historyToggle = $("#background-jobs-history-toggle");
    historyToggle.classList.toggle("hidden", history.length <= 2);
    setTextIfChanged(historyToggle, state.backgroundJobsExpanded ? "Show less" : `Show ${history.length - 2} more`);
    historyToggle.setAttribute("aria-expanded", String(state.backgroundJobsExpanded));
}
async function closeBackgroundJob(jobId) {
    const job = state.backgroundJobs.find((item) => item.id === jobId);
    if (!job)
        return;
    if (backgroundJobIsActive(job)) {
        try {
            const updated = await api(`/api/background-jobs/${jobId}`, { method: "DELETE" });
            state.backgroundJobs = state.backgroundJobs.map((item) => item.id === jobId ? updated : item);
            state.backgroundJobStatuses.set(jobId, updated.status);
        }
        catch (error) {
            return toast(error.message, "error");
        }
    }
    state.dismissedBackgroundJobs.add(jobId);
    renderBackgroundJobs();
}
async function toggleBackgroundJobPause(jobId) {
    const job = state.backgroundJobs.find((item) => item.id === jobId);
    if (!job || !backgroundJobIsActive(job) || job.type === "repository-offboarding")
        return;
    const action = job.status === "paused" ? "resume" : "pause";
    try {
        const updated = await api(`/api/background-jobs/${jobId}/${action}`, { method: "POST" });
        state.backgroundJobs = state.backgroundJobs.map((item) => item.id === jobId ? updated : item);
        state.backgroundJobStatuses.set(jobId, updated.status);
        renderBackgroundJobs();
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function toggleAllBackgroundJobsPause() {
    const jobs = state.backgroundJobs.filter((job) => backgroundJobIsActive(job) && job.type !== "repository-offboarding");
    if (!jobs.length)
        return;
    const action = jobs.every((job) => job.status === "paused") ? "resume" : "pause";
    try {
        const updated = await Promise.all(jobs.filter((job) => action === "resume" ? job.status === "paused" : job.status !== "paused")
            .map((job) => api(`/api/background-jobs/${job.id}/${action}`, { method: "POST" })));
        const byId = new Map(updated.map((job) => [job.id, job]));
        state.backgroundJobs = state.backgroundJobs.map((job) => byId.get(job.id) || job);
        updated.forEach((job) => state.backgroundJobStatuses.set(job.id, job.status));
        renderBackgroundJobs();
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function closeBackgroundActivity() {
    const active = state.backgroundJobs.filter(backgroundJobIsActive);
    if (active.length)
        await Promise.all(active.map((job) => closeBackgroundJob(job.id)));
    state.backgroundJobs.filter((job) => !backgroundJobIsActive(job)).forEach((job) => state.dismissedBackgroundJobs.add(job.id));
    state.backgroundJobsMinimized = false;
    renderBackgroundJobs();
}
async function refreshBackgroundJobs() {
    if (state.backgroundJobsPolling)
        return;
    state.backgroundJobsPolling = true;
    try {
        const jobs = ownerVisibleBackgroundJobs(await api("/api/background-jobs"));
        if (!state.backgroundJobsInitialized) {
            jobs.filter((job) => !backgroundJobIsActive(job)).forEach((job) => state.dismissedBackgroundJobs.add(job.id));
            state.backgroundJobsInitialized = true;
        }
        const previouslyActive = (status) => ["queued", "running", "paused"].includes(status);
        const completedOnboarding = jobs.some((job) => job.type === "repository-onboarding" && !backgroundJobIsActive(job) && previouslyActive(state.backgroundJobStatuses.get(job.id)));
        const completedBackup = jobs.some((job) => job.type === "backup-sync" && !backgroundJobIsActive(job) && previouslyActive(state.backgroundJobStatuses.get(job.id)));
        const completedOffboarding = jobs.some((job) => job.type === "repository-offboarding" && !backgroundJobIsActive(job) && previouslyActive(state.backgroundJobStatuses.get(job.id)));
        state.backgroundJobs = jobs;
        jobs.forEach((job) => state.backgroundJobStatuses.set(job.id, job.status));
        renderBackgroundJobs();
        if (completedOnboarding) {
            state.workspace = await loadWorkspaceSnapshot();
            renderRepositoryTabs();
            const refreshedActiveRepository = state.workspace.repositories.find((repository) => repository.id === state.activeRepository?.id)
                || state.workspace.repositories.find((repository) => repository.id === state.workspace.activeRepositoryId)
                || state.workspace.repositories[0]
                || null;
            state.activeRepository = refreshedActiveRepository;
            syncRepositoryWorkspacePresence();
            if (refreshedActiveRepository)
                await activateRepository(refreshedActiveRepository.id, { forceRefresh: true });
        }
        if (completedBackup && $("#backup-dialog")?.open)
            await refreshBackupStatus();
        else if ($("#backup-dialog")?.open)
            updateBackupFormValidity();
        if (completedOffboarding) {
            storeComposerDraft("repository");
            storeComposerDraft("global");
            await initialize();
        }
    }
    catch { }
    finally {
        state.backgroundJobsPolling = false;
    }
}
async function runGlobalAgent() {
    if (revisionIsBusy("global"))
        return;
    if (await retryRevisionFromComposer("global"))
        return;
    const prompt = $("#global-agent-prompt").value.trim();
    const providerId = $("#global-agent-provider").value;
    const provider = state.providers.find((item) => item.id === providerId);
    const modelSettings = selectedModelSettings("global");
    const repositoryIds = Array.isArray(window.argusNexusRepositoryIds) ? window.argusNexusRepositoryIds.slice(0, 6) : [];
    if (!prompt)
        return toast("Describe the cross-service task first", "error");
    if (!state.workspace.repositories.length)
        return toast("Connect at least one repository first", "error");
    if (!provider?.authenticated)
        return toast(`${provider?.name || "AI provider"} sign-in is required`, "error");
    if (!providerCanRun(provider))
        return toast(providerBlockedMessage(provider), "error");
    const selectionError = modelSelectionError("global");
    if (selectionError)
        return toast(selectionError, "error");
    if (!validateComposerContext("global"))
        return;
    const attachmentIds = scopedAttachments("global").map((item) => item.id);
    const notesCapture = taskPromptNotes.capture("global");
    const draft = takeComposerDraft("global");
    const contextMode = selectedContextMode("global");
    const submission = { ...draft, requestId: crypto.randomUUID(), prompt, providerName: provider.name, contextMode, taskId: activeTaskId("global") || null, repositoryId: "global", createdAt: new Date().toISOString(), startedAt: Date.now(), cancelled: false };
    submission.promptNotes = notesCapture.request.promptNotes;
    submission.previousMessageIds = (checkpointTasks.get("global")?.messages || []).map(message => message.id);
    submission.modelSelectionKey = currentModelSelectionKey("global");
    submission.modelDraftEpoch = modelDraftEpochs.get(submission.modelSelectionKey) || 0;
    state.globalSubmission = submission;
    state.globalSubmitting = true;
    appendOptimisticUserMessage("global", submission);
    setComposerPreparingState("global", true, provider.name);
    let job;
    try {
        job = await api("/api/agents/run", { method: "POST", body: { requestId: submission.requestId, taskId: submission.taskId || undefined, scope: "global", repositoryIds, provider: providerId, mode: $("#global-agent-mode").value, contextMode, ...modelSettings, ...notesCapture.request, prompt, attachmentIds } });
    }
    catch (error) {
        const taskVisible = (activeTaskId("global") || null) === submission.taskId;
        if (taskVisible)
            finishComposerPreparation("global", { failed: true });
        state.globalSubmission = null;
        state.globalSubmitting = false;
        if (submission.cancelled && taskVisible) {
            await refreshTasks("global", false, { preserveSelection: true }).catch(() => { });
            const stoppedDraft = { ...submission, kind: "preparation" };
            if (!await recoverStoppedPrompt("global", stoppedDraft))
                keepComposerRecovery(stoppedDraft);
        }
        else
            restoreComposerDraft(submission);
        if (taskVisible)
            setComposerActionState("global", false);
        return submission.cancelled ? toast("Response stopped") : toast(error.message, "error");
    }
    adoptComposerDraftTask(submission, job.taskId);
    let stopped = await stopReturnedSubmission(job, submission);
    if ((activeTaskId("global") || null) === submission.taskId)
        finishComposerPreparation("global");
    await retainStartedTaskSelection("global", job.taskId, submission, { provider: provider.id, ...modelSettings });
    if (!stopped && submission.cancelled)
        stopped = await stopReturnedSubmission(job, submission);
    taskPromptNotes.submitted(notesCapture, job.taskId);
    state.globalSubmission = null;
    state.globalSubmitting = false;
    state.globalJobs.unshift(job);
    if ((activeTaskId("global") || null) !== submission.taskId || state.currentView !== "global")
        return;
    state.globalJob = job;
    setComposerActionState("global", agentJobIsActive(job));
    try {
        state.activeGlobalTaskId = state.globalJob.taskId;
        syncViewUrl("global", true);
        renderContextTray("global");
        await refreshTasks("global");
        await selectTask("global", state.globalJob.taskId);
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        state.globalSubmitting = false;
    }
    if (stopped?.status === "cancelled" || stopped?.stopRequested === true)
        await recoverStoppedPrompt("global", job);
}
async function refreshCompletedAgentContext(scope, job, isCurrent) {
    if (!isCurrent())
        return;
    const refreshes = [
        refreshTasks(scope, false, { isCurrent, preserveSelection: true }),
        refreshActiveRepository({ refreshConversation: false, isCurrent }),
        (async () => {
            providerStatusPoller.invalidate();
            const providers = await api("/api/agents/providers?refresh=true");
            if (isCurrent()) {
                providerStatusPoller.invalidate();
                state.providers = providers;
                renderProviderOptions();
            }
        })(),
    ];
    if (scope === "repository")
        refreshes.push(importAgentApiRequests(job, { isCurrent }));
    const results = await Promise.allSettled(refreshes);
    if (isCurrent()) {
        void runtimeStateSync?.refresh();
        void repositoryPorts?.refresh();
    }
    if (isCurrent() && results.some(result => result.status === "rejected"))
        toast("Answer is ready. Some background details could not refresh; use Refresh to retry.", "error");
}
async function pollGlobalAgent() {
    if (!state.globalJob || state.pollingGlobalAgent)
        return;
    const requestedJob = state.globalJob;
    const stillCurrent = () => state.globalJob?.id === requestedJob.id && chatRevisionState.acceptsJob(requestedJob, checkpointTasks.get("global"));
    if (!stillCurrent())
        return;
    state.pollingGlobalAgent = true;
    try {
        const update = await api(`/api/agents/jobs/${requestedJob.id}?afterOutput=${requestedJob.outputCursor || 0}&afterError=${requestedJob.errorCursor || 0}`);
        if (!stillCurrent())
            return;
        state.globalJob = mergeAgentJob(state.globalJob, update, requestedJob);
        state.globalJobPollError = null;
        const index = state.globalJobs.findIndex((job) => job.id === state.globalJob.id);
        if (index >= 0)
            state.globalJobs[index] = state.globalJob;
        const visible = activeTaskId("global") === state.globalJob.taskId;
        if (visible) {
            showGlobalJob(state.globalJob);
        }
        else
            renderAgentTabs("global");
        if (!agentJobIsActive(state.globalJob)) {
            clearInterval(state.globalJobTimer);
            if (visible)
                $("#global-agent-status-dot").style.animation = "none";
            const job = state.globalJob;
            try {
                if (visible && job.taskId)
                    await selectTask("global", job.taskId, { background: true,
                        isCurrent: () => stillCurrent() && activeTaskId("global") === job.taskId });
            }
            finally {
                const token = state.taskSelections?.global;
                void refreshCompletedAgentContext("global", job, () => stillCurrent()
                    && activeTaskId("global") === job.taskId && state.taskSelections?.global === token);
            }
        }
    }
    catch (error) {
        if (stillCurrent()) {
            if (!agentJobIsActive(state.globalJob) || (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))) {
                clearInterval(state.globalJobTimer);
                toast(error.message, "error");
            }
            else if (state.globalJobPollError !== requestedJob.id) {
                state.globalJobPollError = requestedJob.id;
                toast(`Live updates interrupted: ${error.message}. Retrying automatically.`, "error");
            }
        }
    }
    finally {
        state.pollingGlobalAgent = false;
    }
}
async function pollAgent() {
    if (!state.activeJob || state.pollingAgent)
        return;
    const requestedJob = state.activeJob;
    const stillCurrent = () => state.activeJob?.id === requestedJob.id && chatRevisionState.acceptsJob(requestedJob, checkpointTasks.get("repository"));
    if (!stillCurrent())
        return;
    state.pollingAgent = true;
    try {
        const update = await api(`/api/agents/jobs/${requestedJob.id}?afterOutput=${requestedJob.outputCursor || 0}&afterError=${requestedJob.errorCursor || 0}`);
        if (!stillCurrent())
            return;
        state.activeJob = mergeAgentJob(state.activeJob, update, requestedJob);
        state.repositoryJobPollError = null;
        const jobIndex = state.repositoryJobs.findIndex((job) => job.id === state.activeJob.id);
        if (jobIndex >= 0)
            state.repositoryJobs[jobIndex] = state.activeJob;
        const visible = activeTaskId("repository") === state.activeJob.taskId;
        if (visible) {
            setComposerActionState("repository", agentJobIsActive(state.activeJob));
            refreshQueuedSteeringControls("repository");
            const statusLabel = agentJobStatusLabel(state.activeJob);
            setTextIfChanged($("#agent-status"), `${statusLabel}${state.activeJob.startedAt ? ` · ${formatMessageTimestamp(state.activeJob.startedAt)}` : ""}`);
            const scrollState = captureLiveScroll(conversationScroller("repository"));
            const outputScrollState = captureLiveScroll($("#agent-output"));
            renderChatContent($("#agent-output"), agentDisplayText(state.activeJob));
            renderAgentQuestionForScope("repository");
            restoreLiveScroll($("#agent-output"), outputScrollState);
            restoreLiveScroll(conversationScroller("repository"), scrollState);
        }
        else
            renderAgentTabs("repository");
        if (!agentJobIsActive(state.activeJob)) {
            clearInterval(state.jobTimer);
            if (visible)
                $("#agent-status-dot").style.animation = "none";
            const job = state.activeJob;
            try {
                if (visible && job.taskId)
                    await selectTask("repository", job.taskId, { background: true,
                        isCurrent: () => stillCurrent() && state.activeRepository?.id === job.repositoryId
                            && activeTaskId("repository") === job.taskId });
            }
            finally {
                const token = state.taskSelections?.repository;
                void refreshCompletedAgentContext("repository", job, () => stillCurrent()
                    && state.activeRepository?.id === job.repositoryId && activeTaskId("repository") === job.taskId
                    && state.taskSelections?.repository === token);
            }
        }
    }
    catch (error) {
        if (stillCurrent()) {
            if (!agentJobIsActive(state.activeJob) || (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))) {
                clearInterval(state.jobTimer);
                toast(error.message, "error");
            }
            else if (state.repositoryJobPollError !== requestedJob.id) {
                state.repositoryJobPollError = requestedJob.id;
                toast(`Live updates interrupted: ${error.message}. Retrying automatically.`, "error");
            }
        }
    }
    finally {
        state.pollingAgent = false;
    }
}
function runtimeDetectionKey() {
    return JSON.stringify([
        (state.workspace?.repositories || []).map(item => [item.id, item.path, item.name]),
        (state.workspace?.runConfigurations || []).map(item => [item.id, item.repositoryId, item.name, item.executable, item.args,
            item.cwd, item.port, item.managementPort, item.configFile, item.runtimeType, item.packageManager, item.launchSource, item.environmentUpdatedAt]),
    ]);
}
function syncServicesRefreshState() {
    const loading = Boolean(state.runtimeDetectionPromise || state.serviceRefreshVisible);
    setRefreshLoading($("#refresh-services"), loading);
    $("#services-toggle").classList.toggle("refreshing", loading);
}
function refreshRuntimeDetections(force = false) {
    if (!state.workspace)
        return Promise.resolve();
    if (state.runtimeDetectionPromise)
        return state.runtimeDetectionPromise;
    const key = runtimeDetectionKey();
    if (!force && key === state.runtimeDetectionLoadedKey && Date.now() - state.runtimeDetectionCheckedAt < 30000)
        return Promise.resolve();
    if (!state.workspace.repositories?.length) {
        state.detectedRuntimes = [];
        state.runtimeDetectionLoadedKey = key;
        state.runtimeDetectionCheckedAt = Date.now();
        return Promise.resolve();
    }
    const operation = Promise.resolve().then(() => api("/api/runtime-detections", { cache: "no-store" }))
        .then(detections => {
        if (key !== runtimeDetectionKey())
            return;
        if (!Array.isArray(detections))
            throw new Error("Could not read project run settings. Use Refresh to retry.");
        const ids = new Set(state.workspace.repositories.map(item => item.id));
        state.detectedRuntimes = detections.filter(item => ids.has(item?.repositoryId));
        state.runtimeDetectionLoadedKey = key;
        state.runtimeDetectionCheckedAt = Date.now();
        renderServices();
    }).catch(error => {
        if (key !== runtimeDetectionKey())
            return;
        state.runtimeDetectionLoadedKey = key;
        state.runtimeDetectionCheckedAt = Date.now();
        toast(`Service cards are available, but project discovery failed: ${error.message}`, "error");
    }).finally(() => {
        if (state.runtimeDetectionPromise === operation)
            state.runtimeDetectionPromise = null;
        syncServicesRefreshState();
        if (key !== runtimeDetectionKey() && state.currentView === "services")
            void refreshRuntimeDetections();
    });
    state.runtimeDetectionPromise = operation;
    syncServicesRefreshState();
    return operation;
}
function pollServiceProcesses() {
    if (document.hidden || !state.workspace)
        return Promise.resolve();
    return refreshProcesses(false, { silent: true });
}
async function refreshProcesses(showSkeleton = false, { silent = false } = {}) {
    if (showSkeleton) {
        renderServices();
        void refreshRuntimeDetections(true);
    }
    if (state.processRefreshPromise)
        return state.processRefreshPromise;
    if (serviceOperations.size)
        return;
    const revision = serviceProcessRevision;
    state.serviceRefreshVisible = showSkeleton;
    state.processRefreshPromise = (async () => {
        try {
            const nextProcesses = await api("/api/processes", { cache: "no-store", dedupe: false, timeout: 5000 });
            if (revision !== serviceProcessRevision || serviceOperations.size)
                return;
            if (!Array.isArray(nextProcesses))
                throw new Error("Could not read service status. Use Refresh to retry.");
            acceptServiceProcesses(nextProcesses, showSkeleton);
        }
        catch (error) {
            if (!silent)
                toast(error.message, "error");
        }
    })().finally(() => { state.processRefreshPromise = null; state.serviceRefreshVisible = false; syncServicesRefreshState(); });
    syncServicesRefreshState();
    return state.processRefreshPromise;
}
function syncIdeRunControls() {
    ideRunControls?.setContext({ repository: state.currentView === "repository" ? state.activeRepository : null,
        configurations: state.workspace?.runConfigurations || [],
        ...(state.serviceProcessSignature !== undefined ? { processes: state.processes } : {}) });
    syncRepositoryPorts();
}
function syncRepositoryPorts() {
    repositoryPorts?.setContext({
        repository: state.activeRepository,
        configurations: state.workspace?.runConfigurations || [],
        selectedConfigurationId: ideRunControls?.state.selectedId,
        processes: state.processes,
        visible: state.currentView === "repository" && Boolean(state.activeRepository)
            && !document.body.classList.contains("workspace-tool-active"),
    });
}
function repositoryPortsInspected(details, { configurationId, configuration }) {
    const current = state.workspace?.runConfigurations?.find(item => item.id === configurationId);
    if (!current || JSON.stringify(current) !== JSON.stringify(configuration))
        return;
    state.servicePortDetails ||= new Map();
    const value = { configuration: JSON.stringify(configuration), applicationPort: details.applicationPort,
        managementPort: details.managementPort, portSource: details.portSource };
    if (JSON.stringify(state.servicePortDetails.get(configurationId)) === JSON.stringify(value))
        return;
    state.servicePortDetails.set(configurationId, value);
    renderServices();
}
function selectRepositoryPortConfiguration(configurationId, repositoryId) {
    if (state.currentView !== "repository" || state.activeRepository?.id !== repositoryId)
        return;
    if (ideRunControls.state.repository?.id !== repositoryId)
        syncIdeRunControls();
    ideRunControls.select(configurationId);
}
function canEditRepositoryPortFile(repositoryId, file) {
    if (state.gitActionRepositories.has(repositoryId))
        throw new Error("Wait for this repository’s Git operation to finish before changing its port.");
    if (repositoryIdeBridge.isFileDirty(repositoryId, file)
        || (state.diffEditor?.repositoryId === repositoryId && state.diffEditor.file === file && diffEditIsDirty()))
        throw new Error(`Save or discard unsaved changes to ${file} before changing the port. Your draft has been kept.`);
    return true;
}
async function repositoryPortsApi(path, options = {}) {
    const edit = /^\/api\/run-configurations\/([^/]+)\/ports$/.exec(path);
    if (!edit || options.method !== "POST")
        return api(path, options);
    const id = decodeURIComponent(edit[1]);
    if (serviceOperations.has(id))
        throw new Error("Wait for this service operation to finish before changing its port.");
    const configuration = state.workspace?.runConfigurations?.find(item => item.id === id);
    if (!configuration)
        throw new Error("This Services configuration no longer exists. Refresh ports before trying again.");
    if (options.body?.configFile)
        canEditRepositoryPortFile(configuration.repositoryId, options.body.configFile);
    return withServiceOperation(id, "ports", () => api(path, options));
}
async function repositoryPortSaved(result, { repositoryId, configurationId }) {
    const revision = Symbol(configurationId);
    repositoryPortRefreshes.set(configurationId, revision);
    let expectedConfiguration = state.workspace?.runConfigurations?.find(item => item.id === configurationId);
    if (expectedConfiguration && Number.isInteger(result.applicationPort) && result.applicationPort >= 1 && result.applicationPort <= 65535) {
        expectedConfiguration = { ...expectedConfiguration, port: result.applicationPort };
        state.workspace.runConfigurations = state.workspace.runConfigurations.map(item => item.id === configurationId ? expectedConfiguration : item);
        renderServices();
    }
    const paths = result.affectedFiles?.length ? result.affectedFiles : [result.configFile || result.file].filter(Boolean);
    for (const file of paths)
        repositoryIdeBridge.invalidateSavedFile(repositoryId, file);
    state.gitStatusVersion++;
    const refreshes = await Promise.allSettled([
        loadWorkspaceSnapshot().then(snapshot => {
            if (repositoryPortRefreshes.get(configurationId) !== revision)
                return;
            const current = state.workspace?.runConfigurations?.find(item => item.id === configurationId);
            if (current !== expectedConfiguration)
                return;
            const updated = snapshot.runConfigurations?.find(item => item.id === configurationId);
            if (updated && state.workspace)
                state.workspace.runConfigurations = state.workspace.runConfigurations.map(item => item.id === configurationId ? updated : item);
            renderServices();
        }),
        Promise.resolve(repositoryIdeBridge.refreshAfterExternalChange(repositoryId, { paths })).then(refreshed => {
            if (refreshed?.failed?.length)
                throw new Error("The editor could not reload the changed configuration. Reopen it to inspect the saved port.");
        }),
        state.activeRepository?.id === repositoryId && state.currentView === "repository" ? refreshVisibleGitStatus({ force: true }) : Promise.resolve(),
    ]);
    if (repositoryPortRefreshes.get(configurationId) === revision)
        repositoryPortRefreshes.delete(configurationId);
    for (const refresh of refreshes)
        if (refresh.status === "rejected")
            toast(`Port saved, but a view could not refresh: ${refresh.reason.message}`, "error");
}
function acceptServiceProcesses(processes, forceRender = false) {
    projectSyncLifecycle.observe(processes);
    serviceProcessRevision++;
    const signature = JSON.stringify(processes), changed = signature !== state.serviceProcessSignature;
    state.processes = processes;
    state.serviceProcessSignature = signature;
    const runningCount = processes.filter(process => process.running).length;
    const runningBadge = $("#running-count");
    if (String(runningBadge.textContent) !== String(runningCount))
        runningBadge.textContent = runningCount;
    $("#services-toggle").classList.toggle("has-running", runningCount > 0);
    $("#services-toggle").classList.toggle("no-running", runningCount === 0);
    if (changed || forceRender)
        renderServices();
}
function acceptServiceProcess(process) {
    if (!process?.id || !process.configurationId)
        return;
    const { logs, ...summary } = process;
    const previous = state.processes.filter(item => item.id !== summary.id).map(item => item.configurationId === summary.configurationId && ["installing", "starting", "running", "stopping"].includes(item.status)
        ? { ...item, running: false, status: "stopped" } : item);
    acceptServiceProcesses([summary, ...previous]);
}
function activeServiceProcesses() {
    return state.processes.filter(process => process?.id && process.configurationId && !process.task
        && ["installing", "starting", "running", "stopping"].includes(process.status));
}
function setServicesStopStatus(message, error = false) {
    const status = $("#services-stop-status");
    status.textContent = message;
    status.hidden = !message;
    status.dataset.state = error ? "error" : "info";
}
function syncStopAllServicesControl() {
    const button = $("#stop-all-services");
    if (!button)
        return;
    const operation = state.stoppingAllServices;
    const count = operation?.count ?? activeServiceProcesses().length;
    const known = state.serviceProcessSignature !== undefined;
    setTextIfChanged(button.querySelector("[data-stop-all-label]"), operation ? "Stopping…" : "Stop all");
    setTextIfChanged(button.querySelector("[data-stop-all-count]"), String(count));
    button.disabled = Boolean(operation || serviceOperations.size || !known || !count);
    button.setAttribute("aria-busy", String(Boolean(operation)));
    button.setAttribute("aria-label", operation ? `Stopping ${count} services` : `Stop all ${count} running services`);
    button.title = operation ? "Stopping Argus-managed services…" : serviceOperations.size
        ? "Wait for the current service operation to finish" : !known ? "Checking running services…" : !count
        ? "No running services to stop" : "Stop all Argus-managed services, including those starting up. Tests, sync jobs and agents are not stopped.";
}
async function stopAllServices() {
    if (state.stoppingAllServices || serviceOperations.size || state.serviceProcessSignature === undefined)
        return;
    const active = activeServiceProcesses();
    if (!active.length) {
        setServicesStopStatus("No running services to stop.");
        return;
    }
    const operation = { mode: "stop", count: active.length };
    const ids = new Set([
        ...(state.workspace?.runConfigurations || []).map(item => item.id),
        ...(state.workspace?.repositories || []).map(item => `repository:${item.id}`),
        ...active.map(item => item.configurationId),
    ].filter(Boolean));
    state.stoppingAllServices = operation;
    for (const id of ids)
        serviceOperations.set(id, operation);
    serviceProcessRevision++;
    setServicesStopStatus(`Stopping ${active.length} service${active.length === 1 ? "" : "s"}…`);
    syncIdeRunControls();
    syncServicePendingControls();
    try {
        const result = await api("/api/processes/stop-services", { method: "POST", timeout: 60000 });
        if (!Array.isArray(result?.targeted) || !Array.isArray(result.stopped)
            || !Array.isArray(result.failures) || !Array.isArray(result.processes)) {
            throw new Error("The server returned an invalid stop result.");
        }
        acceptServiceProcesses(result.processes);
        if (result.failures.length) {
            const failures = result.failures.map(item => `${item.name || item.id || "Service"}: ${item.message || "stop failed"}`).join("; ");
            setServicesStopStatus(`Stopped ${result.stopped.length} of ${result.targeted.length} services. Could not stop ${failures}`, true);
            toast(`Some services could not be stopped. See Services for details.`, "error");
        }
        else {
            const remaining = activeServiceProcesses().length;
            const message = result.targeted.length
                ? `Stopped ${result.stopped.length} service${result.stopped.length === 1 ? "" : "s"}.`
                : "No running services to stop.";
            setServicesStopStatus(message + (remaining ? ` ${remaining} service${remaining === 1 ? " was" : "s were"} started separately and ${remaining === 1 ? "is" : "are"} still active.` : ""));
            toast(message);
        }
    }
    catch (error) {
        let refreshed = false;
        try {
            const processes = await api("/api/processes", { cache: "no-store", dedupe: false, timeout: 5000 });
            if (Array.isArray(processes)) {
                acceptServiceProcesses(processes);
                refreshed = true;
            }
        }
        catch { }
        setServicesStopStatus(`Could not confirm Stop all: ${error.message}. ${refreshed ? "Service status has been refreshed; check the cards before retrying." : "Could not refresh status either. Refresh services before retrying."}`, true);
        toast("Could not confirm Stop all. Check Services before retrying.", "error");
    }
    finally {
        for (const id of ids)
            if (serviceOperations.get(id) === operation)
                serviceOperations.delete(id);
        if (state.stoppingAllServices === operation)
            state.stoppingAllServices = null;
        serviceProcessRevision++;
        syncIdeRunControls();
        syncServicePendingControls();
    }
}
function syncServicePendingControls() {
    syncStopAllServicesControl();
    for (const button of $$("[data-service-action], [data-service-debug], [data-service-maintenance], [data-configure-service], [data-delete-config], [data-start-detected-runtime]")) {
        const id = button.dataset.configId || button.dataset.serviceDebug || button.dataset.maintenanceConfig || button.dataset.configureService || button.dataset.deleteConfig || (button.dataset.startDetectedRuntime ? `repository:${button.dataset.startDetectedRuntime}` : "");
        if (state.stoppingAllServices || serviceOperations.has(id)) {
            if (!("servicePendingDisabled" in button.dataset))
                button.dataset.servicePendingDisabled = String(button.disabled);
            button.disabled = true;
            button.setAttribute("aria-busy", "true");
        }
        else if ("servicePendingDisabled" in button.dataset) {
            button.disabled = button.dataset.servicePendingDisabled === "true";
            delete button.dataset.servicePendingDisabled;
            button.removeAttribute("aria-busy");
        }
    }
}
async function withServiceOperation(configurationId, mode, action) {
    if (state.stoppingAllServices || serviceOperations.has(configurationId))
        return;
    const configuration = state.workspace?.runConfigurations?.find(item => item.id === configurationId);
    const operation = { mode, repositoryId: configuration?.repositoryId };
    serviceOperations.set(configurationId, operation);
    serviceProcessRevision++;
    syncIdeRunControls();
    syncServicePendingControls();
    try {
        const result = await action();
        acceptServiceProcess(result);
        return result;
    }
    finally {
        const revision = serviceProcessRevision;
        try {
            const processes = await api("/api/processes", { cache: "no-store", dedupe: false, timeout: 5000 });
            if (revision === serviceProcessRevision)
                acceptServiceProcesses(processes);
        }
        catch (error) {
            toast(`Could not refresh service status: ${error.message}`, "error");
        }
        finally {
            if (serviceOperations.get(configurationId) === operation)
                serviceOperations.delete(configurationId);
            syncIdeRunControls();
            syncServicePendingControls();
        }
    }
}
function renderServices() {
    syncIdeRunControls();
    syncStopAllServicesControl();
    if (!state.workspace || serviceCardOrder?.isDragging())
        return;
    const drawer = $("#services-drawer");
    const previousScrollTop = drawer.scrollTop;
    const allConfigurations = state.workspace?.runConfigurations || [];
    const configurations = allConfigurations;
    const statusKnown = state.serviceProcessSignature !== undefined;
    $("#services-context").textContent = "All services";
    const configuredRepositoryIds = new Set(configurations.map((configuration) => configuration.repositoryId));
    const unconfiguredRepositories = (state.workspace?.repositories || []).filter((repository) => !configuredRepositoryIds.has(repository.id));
    const cardMarkup = new Map();
    const dragHandle = name => `<button type="button" data-service-card-drag aria-label="Move ${escapeHtml(name)}; Alt+Shift+arrow keys" title="Drag to arrange; Alt+Shift+arrow keys also moves this card">⠿</button>`;
    configurations.forEach((configuration) => {
        const repository = state.workspace.repositories.find((repo) => repo.id === configuration.repositoryId);
        const detectedRuntime = state.detectedRuntimes.find((runtime) => runtime.repositoryId === configuration.repositoryId && runtime.detected);
        const runtimeType = configuration.runtimeType || detectedRuntime?.runtimeType;
        const packageManager = configuration.packageManager || detectedRuntime?.packageManager || configuration.executable;
        const matchingProcesses = state.processes.filter((item) => item.configurationId === configuration.id).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
        const process = matchingProcesses.find((item) => ["installing", "starting", "running", "syncing", "testing", "stopping"].includes(item.status));
        const latestProcess = process || matchingProcesses[0];
        const running = process?.status === "running" && process.running === true;
        const environmentCount = configuration.environmentKeys?.length || configuration.secretKeys?.length || Object.keys(configuration.env || {}).length;
        const inspected = state.servicePortDetails?.get(configuration.id);
        const currentPorts = inspected?.configuration === JSON.stringify(configuration) ? inspected : null;
        const applicationPort = currentPorts ? currentPorts.applicationPort : configuration.port || detectedRuntime?.port;
        const managementPort = currentPorts ? currentPorts.managementPort : configuration.managementPort || detectedRuntime?.managementPort;
        const portSource = currentPorts ? currentPorts.portSource : configuration.port ? "Argus configuration" : detectedRuntime?.portSource || "runtime detection";
        const key = `configuration:${configuration.id}`;
        cardMarkup.set(key, `<article class="service-card" data-service-card="${escapeHtml(key)}" data-service-running="${running}"><header>${dragHandle(configuration.name)}<div><h3>${escapeHtml(configuration.name)}</h3><small>${escapeHtml(repository?.name || "Missing repository")}</small></div><span class="service-state ${running ? "running" : ""}">${process?.status || (statusKnown ? "stopped" : "Checking…")}</span></header>
      <div class="service-command">${runtimeType === "ui" ? `<span class="service-type">UI · ${escapeHtml(packageManager)}</span>` : ""}${escapeHtml([configuration.executable, ...configuration.args].join(" "))}</div>
      <div class="service-ports" title="${escapeHtml(portSource)}">${applicationPort ? `<span>App <strong>:${applicationPort}</strong></span>` : `<span>Port unavailable</span>`}${managementPort ? `<span>Management <strong>:${managementPort}</strong></span>` : ""}<small>${escapeHtml(portSource)}</small></div>
      <div class="service-environment ${environmentCount ? "configured" : ""}"><span>${environmentCount ? "●" : "○"}</span>${environmentCount ? `${environmentCount} environment variables saved locally` : "Environment not configured"}</div>
      <div class="service-actions">
        <button class="run" data-service-action="${process ? "stop" : "start"}" data-config-id="${configuration.id}" ${repository && statusKnown ? "" : "disabled"}>${process ? `■ Stop ${process.status}` : runtimeType === "ui" ? "▶ Start UI" : "▶ Start"}</button>
        ${repository && !process ? `<button data-service-debug="${configuration.id}" ${statusKnown ? "" : "disabled"} title="Start with a loopback-only debugger port; supported Java and Node launchers">Debug</button>` : ""}
        ${repository && process?.debug ? `<button data-service-debugger="${repository.id}" title="Open the IDE debugger">Debugger :${Number(process.debug.port) || "—"}</button>` : ""}
        ${repository ? `<button class="${process?.status === "syncing" ? "maintenance-loading" : ""}" data-service-maintenance="sync" data-maintenance-repository="${repository.id}" data-maintenance-config="${configuration.id}" data-maintenance-name="${escapeHtml(configuration.name)}" ${process || !statusKnown ? "disabled" : ""}>${process?.status === "syncing" ? "Syncing…" : runtimeType === "ui" ? "Sync modules" : "Sync project"}</button><button class="${process?.status === "testing" ? "maintenance-loading" : ""}" data-service-maintenance="test" data-maintenance-repository="${repository.id}" data-maintenance-config="${configuration.id}" data-maintenance-name="${escapeHtml(configuration.name)}" ${process || !statusKnown ? "disabled" : ""}>${process?.status === "testing" ? "Testing…" : "Run tests"}</button>` : ""}
        <button data-configure-service="${configuration.id}" data-service-repository="${repository?.id || ""}">Configure</button>
        ${repository ? `<button data-service-codex="${repository.id}">✦ AI</button>` : ""}
        ${latestProcess ? `<button data-show-logs="${latestProcess.id}" data-log-config-id="${configuration.id}" data-service-name="${escapeHtml(configuration.name)}">Logs</button>` : ""}${process && !process.task ? `<button data-service-action="restart" data-config-id="${configuration.id}">Restart</button>` : ""}
        <button data-delete-config="${configuration.id}">Delete</button>
      </div></article>`);
    });
    unconfiguredRepositories.forEach((repository) => {
        const runtime = (state.detectedRuntimes || []).find((item) => item.repositoryId === repository.id);
        const runnable = Boolean(runtime?.detected);
        const isUi = runtime?.runtimeType === "ui";
        const command = runnable ? [runtime.executable, ...(runtime.args || [])].join(" ") : "Run command will be detected when configured";
        const maintenanceId = `repository:${repository.id}`;
        const matchingProcesses = state.processes.filter((item) => item.configurationId === maintenanceId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
        const process = matchingProcesses.find((item) => ["syncing", "testing", "stopping"].includes(item.status));
        const latestProcess = process || matchingProcesses[0];
        const key = `repository:${repository.id}`;
        cardMarkup.set(key, `<article class="service-card detected-runtime-card" data-service-card="${escapeHtml(key)}"><header>${dragHandle(repository.name)}<div><h3>${escapeHtml(repository.name)}</h3><small>${runnable ? `${isUi ? "UI" : "Service"} detected` : "Default configuration"}</small></div><span class="service-state">not configured</span></header>
      <div class="service-command">${isUi ? `<span class="service-type">UI · ${escapeHtml(runtime.packageManager || runtime.executable)}</span>` : ""}${escapeHtml(command)}</div>
      ${runnable ? `<div class="service-ports" title="${escapeHtml(runtime.portSource || "runtime detection")}"><span>App <strong>${runtime.port ? `:${escapeHtml(runtime.port)}` : "Not configured"}</strong></span>${runtime.managementPort ? `<span>Management <strong>:${runtime.managementPort}</strong></span>` : ""}<small>${escapeHtml(runtime.portSource || "runtime detection")}</small></div>` : ""}
      <p class="detected-ui-note">${runnable ? (isUi ? "Argus installs missing dependencies before starting the development server." : "Add local environment values if needed, then start this service.") : escapeHtml(runtime?.error || "Configure this repository before running it.")}</p>
      <div class="service-actions">${runnable ? `<button class="run" data-start-detected-runtime="${repository.id}" ${process || !statusKnown ? "disabled" : ""}>▶ ${isUi ? "Start UI" : "Start"}</button><button class="${process?.status === "syncing" ? "maintenance-loading" : ""}" data-service-maintenance="sync" data-maintenance-repository="${repository.id}" data-maintenance-config="${maintenanceId}" data-maintenance-name="${escapeHtml(repository.name)}" ${process || !statusKnown ? "disabled" : ""}>${process?.status === "syncing" ? "Syncing…" : isUi ? "Sync modules" : "Sync project"}</button><button class="${process?.status === "testing" ? "maintenance-loading" : ""}" data-service-maintenance="test" data-maintenance-repository="${repository.id}" data-maintenance-config="${maintenanceId}" data-maintenance-name="${escapeHtml(repository.name)}" ${process || !statusKnown ? "disabled" : ""}>${process?.status === "testing" ? "Testing…" : "Run tests"}</button>` : ""}<button data-configure-service="" data-service-repository="${repository.id}">Configure</button><button data-service-codex="${repository.id}">✦ AI</button>${latestProcess ? `<button data-show-logs="${latestProcess.id}" data-log-config-id="${maintenanceId}" data-service-name="${escapeHtml(repository.name)}">Logs</button>` : ""}</div></article>`);
    });
    const cards = buildServiceCards(state.workspace?.repositories || [], configurations);
    serviceCardOrder.restore(state.workspace?.preferences?.serviceCardOrder);
    const markup = serviceCardOrder.arrange(cards).map(card => cardMarkup.get(card.key)).join("") || `<div class="empty-list">No repositories are connected yet.</div>`;
    if (state.serviceCardMarkup !== markup) {
        $("#service-list").innerHTML = markup;
        state.serviceCardMarkup = markup;
    }
    syncServicePendingControls();
    drawer.scrollTop = previousScrollTop;
    requestAnimationFrame(() => { if (state.currentView === "services")
        drawer.scrollTop = previousScrollTop; });
}
function rememberServiceConfiguration(configuration) {
    if (!state.workspace || !configuration?.id)
        return;
    state.workspace = { ...state.workspace, runConfigurations: [
            ...(state.workspace.runConfigurations || []).filter(item => item.id !== configuration.id), configuration,
        ] };
    renderServices();
}
async function startDetectedRuntime(repositoryId) {
    return withServiceOperation(`repository:${repositoryId}`, "start", async () => {
        try {
            toast("Preparing service…");
            const configuration = state.workspace?.runConfigurations?.find(item => item.repositoryId === repositoryId)
                || await api("/api/run-configurations", { method: "POST", body: { simpleSetup: true, repositoryId } });
            rememberServiceConfiguration(configuration);
            state.workspace = await loadWorkspaceSnapshot();
            await withServiceOperation(configuration.id, "start", () => api(`/api/run-configurations/${configuration.id}/start`, { method: "POST" }));
            await refreshProcesses(true);
            toast(configuration.runtimeType === "ui" ? "UI setup started. Dependency installation progress is available in Logs." : "Service started");
        }
        catch (error) {
            toast(error.message, "error");
        }
    });
}
async function saveService(event) {
    event.preventDefault();
    if (state.serviceConfigurationSaving)
        return;
    const serviceForm = event.currentTarget;
    const form = new FormData(serviceForm);
    if (serviceOperations.has(form.get("configurationId")) || serviceOperations.has(`repository:${form.get("repositoryId")}`)) {
        toast("Wait for the current service operation before changing its configuration.", "error");
        return;
    }
    const hasApplicationYaml = !$("#application-yaml-section").classList.contains("hidden");
    let saved = false;
    try {
        const body = serviceConfigurationInput(form);
        state.serviceConfigurationSaving = true;
        $("#save-service").disabled = true;
        const configuration = await api("/api/run-configurations", { method: "POST", body });
        serviceForm.elements.configurationId.value = configuration.id;
        saved = true;
        rememberServiceConfiguration(configuration);
        state.workspace = await loadWorkspaceSnapshot();
        $("#service-dialog").close();
        renderServices();
        await refreshProcesses(true);
        await refreshActiveRepository();
        toast(hasApplicationYaml ? "Service, local environment and application.yml saved" : "Service and local environment saved");
    }
    catch (error) {
        toast(saved ? `Configuration saved, but the view could not refresh. Retrying updates the same service. ${error.message}` : error.message, "error");
    }
    finally {
        state.serviceConfigurationSaving = false;
        $("#save-service").disabled = false;
    }
}
function renderServiceLaunchMode() {
    const form = $("#service-form");
    const manual = form.elements.launchMode.value === "custom";
    $("#service-command-fields").hidden = !manual;
    $("#service-command-fields").querySelectorAll("input, textarea").forEach(control => { control.disabled = !manual; });
    form.elements.commandExecutable.required = manual;
}
function setEnvironmentFormat(format, { convert = true } = {}) {
    const form = $("#service-form");
    const currentFormat = form.elements.environmentFormat.value || "dotenv";
    const input = form.elements.environmentInput;
    if (convert && currentFormat !== format && input.value.trim()) {
        try {
            input.value = convertEnvironmentFormat(input.value, currentFormat, format);
        }
        catch (error) {
            toast(error.message, "error");
            return false;
        }
    }
    form.elements.environmentFormat.value = format;
    $$("[data-environment-format]").forEach((button) => button.classList.toggle("active", button.dataset.environmentFormat === format));
    $("#environment-input-label").textContent = format === "vault" ? "Vault JSON object" : ".env values";
    input.placeholder = format === "vault"
        ? `{\n  "SPRING_PROFILES_ACTIVE": "local",\n  "FEATURE_RULES": { "enabled": true },\n  "ALLOWED_CUSTOMERS": ["customer-1", "customer-2"]\n}`
        : "SPRING_PROFILES_ACTIVE=local\nDATABASE_URL=...\nAPI_TOKEN=...";
}
async function openServiceConfiguration(configurationId = "", repositoryId = state.activeRepository?.id) {
    if (!repositoryId)
        return toast("Open a repository first", "error");
    if (state.serviceConfigurationSaving)
        return;
    const revision = state.serviceConfigurationRevision = (state.serviceConfigurationRevision || 0) + 1;
    try {
        const suffix = configurationId ? `?configurationId=${encodeURIComponent(configurationId)}` : "";
        const setup = await api(`/api/repositories/${repositoryId}/run-configuration-template${suffix}`);
        if (revision !== state.serviceConfigurationRevision)
            return;
        const form = $("#service-form");
        form.reset();
        form.elements.configurationId.value = configurationId;
        form.elements.repositoryId.value = repositoryId;
        form.elements.launchMode.value = setup.detected === false || setup.launchSource === "custom" ? "custom" : "detected";
        form.elements.launchMode.querySelector('option[value="detected"]').disabled = setup.detected === false;
        form.elements.commandName.value = setup.name || "";
        form.elements.commandExecutable.value = setup.executable || "";
        form.elements.commandArguments.value = JSON.stringify(setup.args || []);
        form.elements.commandCwd.value = setup.cwd || ".";
        form.elements.commandPort.value = setup.port || "";
        $("#service-detection-note").textContent = setup.detectionWarning || "Automatic uses the detected project entry point. Custom lets you supply an executable and arguments; no shell expansion is performed.";
        renderServiceLaunchMode();
        form.elements.configFile.value = setup.configFile || "";
        form.elements.applicationYaml.value = setup.applicationYaml || "";
        const hasApplicationYaml = Boolean(setup.applicationYamlExists && setup.configFile);
        $("#application-yaml-section").classList.toggle("hidden", !hasApplicationYaml);
        $("#service-dialog .service-setup-card").classList.toggle("without-yaml", !hasApplicationYaml);
        $("#service-setup-description").textContent = hasApplicationYaml
            ? "Choose how this repository runs, then manage its local environment and application.yml."
            : "Choose how this repository runs and manage its local environment. Saving does not start it.";
        setEnvironmentFormat(setup.environment?.format || "dotenv", { convert: false });
        form.elements.environmentInput.value = setup.environment?.content || "";
        $("#service-setup-title").textContent = `Configure ${setup.name}`;
        const environment = setup.environment || {};
        $("#local-environment-status").innerHTML = environment.count
            ? `<span>✓</span><div><strong>${environment.count} values saved in the local .env snapshot</strong><small>Last refreshed ${environment.updatedAt ? relativeTime(environment.updatedAt) : "locally"}. Paste the latest complete Vault JSON object or .env values to replace it.</small></div>`
            : `<span>⌾</span><div><strong>No local environment saved yet</strong><small>Pasting values creates a private .env snapshot outside the repository.</small></div>`;
        showAppDialog("service-dialog");
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function serviceAction(configurationId, action) {
    return withServiceOperation(configurationId, action, async () => {
        try {
            const process = await api(`/api/run-configurations/${configurationId}/${action}`, { method: "POST" });
            toast(action === "start" ? "Service started" : action === "stop" ? "Service stopped" : "Service restarted");
            if (state.activeLogConfigurationId === configurationId) {
                cancelServiceLogCopy();
                state.activeLogProcessId = null;
                state.logCursor = 0;
                renderServiceLogCopy();
                $("#log-output").textContent += `\n── ${action === "restart" ? "Restarting service" : action === "start" ? "Starting service" : "Service stopped"} ──\n`;
            }
            return process;
        }
        catch (error) {
            toast(error.message, "error");
        }
    });
}
async function startServiceDebug(button) {
    const configurationId = button.dataset.serviceDebug;
    const configuration = state.workspace?.runConfigurations?.find(item => item.id === configurationId);
    if (!configuration)
        return;
    return withServiceOperation(configurationId, "debug", async () => {
        button.disabled = true;
        button.textContent = "Starting debug…";
        try {
            const process = await api(`/api/run-configurations/${configurationId}/start`, { method: "POST", body: { debug: true } });
            toast(`Debug service started${process.debug?.port ? ` on localhost:${process.debug.port}` : ""}. Open Debugger to attach.`);
            return process;
        }
        catch (error) {
            toast(error.message, "error");
        }
        finally {
            button.disabled = false;
            button.textContent = "Debug";
        }
    });
}
async function runServiceMaintenance(button) {
    const action = button.dataset.serviceMaintenance;
    return withServiceOperation(button.dataset.maintenanceConfig, action, async () => {
        const original = button.textContent;
        button.disabled = true;
        button.classList.add("maintenance-loading");
        button.textContent = action === "sync" ? "Syncing…" : "Testing…";
        try {
            const process = await api(`/api/repositories/${button.dataset.maintenanceRepository}/project-structure/maintenance`, { method: "POST", body: { action, configurationId: button.dataset.maintenanceConfig } });
            if (action === "sync")
                projectSyncLifecycle.track(process);
            acceptServiceProcess(process);
            await showLogs(process.id, button.dataset.maintenanceName, button.dataset.maintenanceConfig);
            toast(action === "sync" ? "Dependency sync started; progress is shown in Logs" : "Tests started; progress is shown in Logs");
        }
        catch (error) {
            button.disabled = false;
            button.classList.remove("maintenance-loading");
            button.textContent = original;
            toast(error.message, "error");
        }
    });
}
function serviceLogsVisible() {
    return !$("#log-console").classList.contains("hidden") && !$("#services-drawer").classList.contains("hidden");
}
function renderServiceLogCopy() {
    const button = $("#copy-service-logs");
    button.disabled = !serviceLogsVisible() || !state.activeLogProcessId || Boolean(state.logCopyRequest);
    button.textContent = state.logCopyRequest ? "Copying…" : "Copy all logs";
}
function serviceLogCopyFeedback(message = "", failed = false) {
    const feedback = $("#log-copy-feedback");
    feedback.textContent = message;
    feedback.classList.toggle("hidden", !message);
    feedback.dataset.state = failed ? "error" : "success";
}
function cancelServiceLogCopy() {
    state.logCopyRequest?.controller.abort();
    state.logCopyRequest = null;
    serviceLogCopyFeedback();
    renderServiceLogCopy();
}
function closeServiceLogs() {
    clearInterval(state.logTimer);
    state.logTimer = null;
    state.logEpoch++;
    state.logRequest?.controller.abort();
    state.logRequest = null;
    state.activeLogConfigurationId = null;
    state.activeLogProcessId = null;
    $("#log-console").classList.add("hidden");
    cancelServiceLogCopy();
}
async function copyAllServiceLogs() {
    if (!serviceLogsVisible() || !state.activeLogProcessId || state.logCopyRequest)
        return;
    const pending = { epoch: state.logEpoch, processId: state.activeLogProcessId, controller: new AbortController() };
    state.logCopyRequest = pending;
    serviceLogCopyFeedback();
    renderServiceLogCopy();
    const current = () => serviceLogsVisible() && state.logEpoch === pending.epoch
        && state.activeLogProcessId === pending.processId && state.logCopyRequest === pending;
    try {
        if (typeof navigator.clipboard?.writeText !== "function")
            throw new Error("Clipboard is unavailable");
        const result = await api(`/api/processes/${encodeURIComponent(pending.processId)}/logs?after=0`, {
            signal: pending.controller.signal, dedupe: false, cache: "no-store", timeout: 10000,
        });
        if (!current())
            return;
        const snapshot = formatProcessLogSnapshot(result);
        if (!snapshot.count) {
            serviceLogCopyFeedback(snapshot.message);
            return;
        }
        await navigator.clipboard.writeText(snapshot.text);
        if (current())
            serviceLogCopyFeedback(snapshot.message);
    }
    catch {
        if (current())
            serviceLogCopyFeedback("Could not copy logs. Click Copy all logs to try again.", true);
    }
    finally {
        if (state.logCopyRequest === pending) {
            state.logCopyRequest = null;
            renderServiceLogCopy();
        }
    }
}
async function showLogs(processId, name, configurationId) {
    closeServiceLogs();
    $("#log-console").classList.remove("hidden");
    $("#log-title").textContent = `${name} · logs`;
    state.activeLogConfigurationId = configurationId;
    state.activeLogProcessId = processId;
    state.logCursor = 0;
    $("#log-output").textContent = "";
    renderServiceLogCopy();
    const epoch = state.logEpoch;
    const current = () => state.logEpoch === epoch && state.activeLogConfigurationId === configurationId && serviceLogsVisible();
    const poll = async () => {
        if (!current() || state.logRequest)
            return;
        const pending = { controller: new AbortController() };
        state.logRequest = pending;
        const options = { signal: pending.controller.signal, dedupe: false, cache: "no-store", timeout: 5000 };
        try {
            const previousProcessId = state.activeLogProcessId;
            const processList = await api("/api/processes", options);
            if (!current() || state.activeLogProcessId !== previousProcessId)
                return;
            const candidates = processList.filter((item) => item.configurationId === configurationId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
            const currentProcess = candidates[0];
            if (!currentProcess)
                return;
            if (state.activeLogProcessId !== currentProcess.id) {
                cancelServiceLogCopy();
                state.activeLogProcessId = currentProcess.id;
                state.logCursor = 0;
                renderServiceLogCopy();
                $("#log-output").textContent += `${$("#log-output").textContent ? "\n" : ""}── New process · ${new Date(currentProcess.startedAt).toLocaleTimeString()} ──\n`;
            }
            const selectedProcessId = state.activeLogProcessId, after = state.logCursor;
            const result = await api(`/api/processes/${encodeURIComponent(selectedProcessId)}/logs?after=${after}`, options);
            if (!current() || state.activeLogProcessId !== selectedProcessId)
                return;
            if (!Array.isArray(result?.logs) || !Number.isSafeInteger(result.cursor) || result.cursor < after)
                throw new Error("Invalid log response");
            state.logCursor = result.cursor;
            if (result.logs.length) {
                const output = $("#log-output");
                const scrollState = captureLiveScroll(output);
                output.textContent += `${result.logs.map(formatProcessLogEntry).join("\n")}\n`;
                restoreLiveScroll(output, scrollState);
            }
        }
        catch (error) {
            if (current())
                console.warn("Log refresh failed; retrying", error);
        }
        finally {
            if (state.logRequest === pending)
                state.logRequest = null;
        }
    };
    await poll();
    if (current())
        state.logTimer = setInterval(poll, 1000);
}
function collectionOptions(selectedId = "", placeholder = "Select a collection…") {
    const collections = state.apiCollections;
    return `<option value="" ${selectedId ? "" : "selected"}>${escapeHtml(placeholder)}</option>${collections.map((collection) => {
        const segments = String(collection.name).split(/\s*\/\s*/).filter(Boolean);
        const label = `${"\u00a0\u00a0".repeat(Math.max(0, segments.length - 1))}${segments.at(-1) || collection.name}`;
        return `<option value="${collection.id}" ${collection.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("")}`;
}
function renderApiCollectionOptions(selectedId = "") {
    $("#api-request-collection").innerHTML = collectionOptions(selectedId);
    $("#curl-request-collection").innerHTML = collectionOptions("", "Prepare without saving");
}
async function refreshApiClientData(render = true) {
    [state.apiRequests, state.apiCollections] = await Promise.all([
        api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests`),
        api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-collections`),
    ]);
    if (render)
        renderApiRequestList();
}
function renderApiRequestList() {
    const requests = state.apiRequests || [];
    $("#api-request-count").textContent = requests.length;
    $("#api-sidebar-count").textContent = requests.length;
    const collections = state.apiCollections || [];
    const requestRows = (items, depth = 1) => items.map((request) => `
      <div class="api-request-row ${request.id === state.activeApiRequest?.id ? "active" : ""}" style="--api-tree-depth:${depth}">
        <button type="button" class="api-request-open" data-api-request-id="${escapeHtml(request.id)}">
          <span class="api-method ${escapeHtml(request.method)}">${escapeHtml(request.method)}</span>
          <span><strong>${escapeHtml(request.name)}</strong><small>${escapeHtml(ensureApiPreviewProtocol(resolvedApiPreview(request.url, request.variables)))}</small></span>
        </button>
        <button type="button" class="api-request-delete" data-delete-api-request="${escapeHtml(request.id)}" title="Delete ${escapeHtml(request.name)}" aria-label="Delete ${escapeHtml(request.name)}">×</button>
      </div>`).join("");
    const renderCollection = (node, depth = 0) => {
        const id = node.key;
        const collapsed = state.collapsedApiCollections.has(id);
        const collection = node.collection;
        const childCollections = node.children.map((child) => renderCollection(child, depth + 1)).join("");
        const directRequests = requestRows(node.requests, depth + 1);
        return `<section class="api-collection-group api-tree-node ${depth === 0 ? "api-tree-root" : "api-tree-child"} ${collapsed ? "collapsed" : "expanded"}" style="--api-tree-depth:${depth}">
      <div class="api-collection-heading">
        <button type="button" class="api-collection-toggle" data-api-collection-toggle="${escapeHtml(id)}" aria-expanded="${!collapsed}">
          <svg class="api-collection-chevron disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"></path></svg><span class="api-collection-folder" aria-hidden="true"></span><strong class="api-collection-name"><span class="current">${escapeHtml(node.name)}</span></strong><span class="api-collection-count">${node.requestCount}</span>
        </button>
        ${collection
            ? `<button type="button" class="api-collection-delete" data-delete-api-collection="${escapeHtml(collection.id)}" title="Delete ${escapeHtml(collection.name)} and everything inside it" aria-label="Delete ${escapeHtml(collection.name)} and everything inside it">×</button>`
            : `<button type="button" class="api-collection-delete" data-delete-api-collection-path="${escapeHtml(node.path.join(" / "))}" title="Delete ${escapeHtml(node.name)} and everything inside it" aria-label="Delete ${escapeHtml(node.name)} and everything inside it">×</button>`}
      </div>
      <div class="api-tree-contents ${collapsed ? "hidden" : ""}">${childCollections}${directRequests ? `<div class="api-collection-requests">${directRequests}</div>` : ""}</div>
    </section>`;
    };
    const grouped = buildApiCollectionTree(collections, requests).map((node) => renderCollection(node)).join("");
    $("#api-request-list").innerHTML = grouped
        ? grouped
        : `<div class="empty-list">No requests yet.<br />Create a collection, add a request, paste cURL, or import JSON.</div>`;
}
function toggleApiCollection(collectionId) {
    if (state.collapsedApiCollections.has(collectionId))
        state.collapsedApiCollections.delete(collectionId);
    else
        state.collapsedApiCollections.add(collectionId);
    localStorage.setItem("argus-collapsed-api-collections", JSON.stringify([...state.collapsedApiCollections]));
    renderApiRequestList();
}
async function deleteApiCollection(collectionId, syntheticPath = "") {
    const collection = state.apiCollections.find((item) => item.id === collectionId);
    const collectionName = collection?.name || syntheticPath;
    if (!collectionName)
        return;
    const prefix = `${collectionName} / `;
    const collectionIds = new Set(state.apiCollections.filter((item) => item.id === collectionId || item.name.startsWith(prefix)).map((item) => item.id));
    const requestCount = state.apiRequests.filter((request) => collectionIds.has(request.collectionId)).length;
    const descendantCount = Math.max(0, collectionIds.size - 1);
    const consequence = `${requestCount} saved request${requestCount === 1 ? "" : "s"}${descendantCount ? ` and ${descendantCount} nested folder${descendantCount === 1 ? "" : "s"}` : ""} will be permanently deleted from local storage.`;
    if (!confirm(`Delete collection “${collectionName}” and everything inside it?\n\n${consequence}`))
        return;
    try {
        const result = collection
            ? await api(`/api/api-collections/${collection.id}`, { method: "DELETE" })
            : await api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-collections?path=${encodeURIComponent(collectionName)}`, { method: "DELETE" });
        await refreshApiClientData(false);
        state.collapsedApiCollections.delete(collection?.id || `path:${collectionName}`);
        localStorage.setItem("argus-collapsed-api-collections", JSON.stringify([...state.collapsedApiCollections]));
        renderApiRequestList();
        renderApiCollectionOptions();
        if (state.activeApiRequest)
            editApiRequest(state.apiRequests.find((item) => item.id === state.activeApiRequest.id) || null);
        toast(`Deleted ${result.deletedCollectionCount} collection${result.deletedCollectionCount === 1 ? "" : "s"} and ${result.deletedRequestCount} request${result.deletedRequestCount === 1 ? "" : "s"}`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function deleteApiRequestById(requestId) {
    const request = state.apiRequests.find((item) => item.id === requestId);
    if (!request || !confirm(`Delete request “${request.name}”?`))
        return;
    try {
        await api(`/api/api-requests/${request.id}`, { method: "DELETE" });
        await refreshApiClientData(false);
        if (state.activeApiRequest?.id === request.id)
            editApiRequest(state.apiRequests[0] || null);
        else
            renderApiRequestList();
        toast(`${request.name} deleted`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function resetApiResponse() {
    state.apiResponse = null;
    state.apiResponseRequestKey = null;
    $("#api-response-status").className = "";
    $("#api-response-status").textContent = "Not sent";
    $("#api-response-meta").textContent = "";
    renderResponseContent($("#api-response-body"), "Send the request to see its response here.", false);
    renderResponseContent($("#api-response-headers"), "", false);
}
function apiParameterContainer(kind) {
    return kind === "query" ? $("#api-query-parameters") : $("#api-header-parameters");
}
function apiParameterJsonInput(kind) {
    return $("#api-request-form").elements[kind === "query" ? "queryParamsText" : "headersText"];
}
function apiParameterRows(kind, raw = false) {
    const container = apiParameterContainer(kind);
    return [...container.querySelectorAll(".api-parameter-row")].map((row) => ({
        key: raw ? row.querySelector("[data-api-parameter-key]").value : row.querySelector("[data-api-parameter-key]").value.trim(),
        value: row.querySelector("[data-api-parameter-value]").value,
        description: (raw ? row.querySelector("[data-api-parameter-description]")?.value : row.querySelector("[data-api-parameter-description]")?.value.trim()) || "",
        enabled: row.querySelector("[data-api-parameter-enabled]").checked,
    })).filter((item) => item.key || item.value || item.description);
}
function updateApiParameterCounts() {
    for (const kind of ["query", "headers"]) {
        updateApiParameterCount(kind, apiParameterRows(kind));
    }
}
function updateApiParameterCount(kind, parameters) {
    const count = normalizeRequestParameters(parameters).filter((item) => item.enabled && item.key).length;
    const badge = kind === "query" ? $("#api-query-count") : $("#api-header-count");
    badge.textContent = String(count);
    badge.dataset.count = String(count);
}
function renderApiParameterRows(kind, parameters = []) {
    const container = apiParameterContainer(kind);
    const normalized = normalizeRequestParameters(parameters);
    container.innerHTML = normalized.length ? normalized.map((item) => `<div class="api-parameter-row" data-api-parameter-row="${kind}">
    <input type="checkbox" data-api-parameter-enabled aria-label="Enable ${kind === "query" ? "query parameter" : "header"}" ${item.enabled ? "checked" : ""} />
    <input type="text" data-api-parameter-key aria-label="${kind === "query" ? "Query parameter" : "Header"} name" placeholder="${kind === "query" ? "parameter" : "header"}" value="${escapeHtml(item.key)}" />
    <input type="text" data-api-parameter-value class="${/\{\{\s*[^{}]+?\s*\}\}/.test(item.value) ? "contains-api-variable" : ""}" aria-label="${kind === "query" ? "Query parameter" : "Header"} value" placeholder="Value" value="${escapeHtml(item.value)}" />
    ${kind === "query" ? `<input type="text" data-api-parameter-description aria-label="Query parameter description" placeholder="Description (optional)" value="${escapeHtml(item.description)}" />` : ""}
    <button type="button" data-remove-api-parameter aria-label="Remove ${kind === "query" ? "query parameter" : "header"}" title="Remove">×</button>
  </div>`).join("") : `<div class="api-parameter-empty">No ${kind === "query" ? "query parameters" : "headers"} yet.</div>`;
    updateApiParameterCounts();
}
function apiParametersFromJson(kind) {
    const raw = apiParameterJsonInput(kind).value.trim() || "{}";
    try {
        return requestParametersFromObject(JSON.parse(raw));
    }
    catch (error) {
        if (error instanceof SyntaxError)
            throw new Error(`${kind === "query" ? "Query parameters" : "Headers"} must be a valid JSON object`);
        throw new Error(`${kind === "query" ? "Query parameters" : "Headers"} must be a JSON object`);
    }
}
function apiParametersFromForm(kind) {
    const pane = $(`#api-${kind}-editor`);
    return pane.dataset.parameterView === "json" ? apiParametersFromJson(kind) : apiParameterRows(kind);
}
function syncApiParameterJson(kind) {
    apiParameterJsonInput(kind).value = JSON.stringify(requestParametersToObject(apiParameterRows(kind)), null, 2);
}
function setApiParameterView(kind, view, quiet = false) {
    const pane = $(`#api-${kind}-editor`);
    if (view === "json")
        syncApiParameterJson(kind);
    else {
        try {
            renderApiParameterRows(kind, apiParametersFromJson(kind));
        }
        catch (error) {
            if (!quiet)
                toast(error.message, "error");
            return false;
        }
    }
    pane.dataset.parameterView = view;
    apiParameterContainer(kind).classList.toggle("hidden", view !== "table");
    apiParameterJsonInput(kind).classList.toggle("hidden", view !== "json");
    $$(`[data-api-parameter-view^="${kind}:"]`).forEach((button) => button.classList.toggle("active", button.dataset.apiParameterView === `${kind}:${view}`));
    if (kind === "query")
        syncApiUrlFromParameters();
    return true;
}
function syncApiUrlFromParameters() {
    const input = $("#api-request-form").elements.url;
    let parameters;
    try {
        parameters = apiParametersFromForm("query");
    }
    catch {
        return;
    }
    const template = composeUrlWithQuery(input.dataset.template ?? input.value, parameters);
    input.dataset.template = template;
    showResolvedApiUrl();
    if ($("#api-query-editor").dataset.parameterView === "table")
        updateApiParameterCounts();
}
function addApiParameterRow(kind) {
    const parameters = apiParameterRows(kind);
    parameters.push({ key: "", value: "", description: "", enabled: true });
    renderApiParameterRows(kind, parameters);
    const container = apiParameterContainer(kind);
    container.querySelector(".api-parameter-row:last-child [data-api-parameter-key]")?.focus();
}
function renderApiRequestHistory() {
    const entries = apiRequestHistory.entries;
    $("#api-history-count").textContent = String(entries.length);
    $("#api-history-list").innerHTML = historyRowsMarkup(entries, $("#api-history-search").value);
}
function selectApiSidebar(view) {
    const history = view === "history";
    $("#api-saved-pane").classList.toggle("hidden", history);
    $("#api-request-history").classList.toggle("hidden", !history);
    for (const name of ["saved", "history"]) {
        const button = $(`#api-${name}-tab`), active = name === view;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
    }
}
async function refreshApiRequestHistory() {
    $("#api-history-status").textContent = "Loading history…";
    try {
        await apiRequestHistory.refresh();
        $("#api-history-status").textContent = "";
    }
    catch {
        $("#api-history-status").textContent = "Could not load history. Refresh to try again; your entries have not been removed.";
    }
}
function captureApiRequestSnapshot(kind) {
    const form = $("#api-request-form");
    const snapshot = {
        version: 1,
        kind: kind || (state.apiResponse?.transportError ? "failed" : state.apiResponse ? "sent" : "draft"),
        request: {
            ...(state.activeApiRequest || {}), id: form.elements.id.value || undefined,
            name: form.elements.name.value, method: form.elements.method.value,
            url: form.elements.url.value, body: form.elements.body.value,
            collectionId: form.elements.collectionId.value || null,
        },
        editor: {
            queryRows: apiParameterRows("query", true), headerRows: apiParameterRows("headers", true),
            queryText: form.elements.queryParamsText.value, headersText: form.elements.headersText.value,
            queryView: $("#api-query-editor").dataset.parameterView,
            headerView: $("#api-headers-editor").dataset.parameterView,
            tab: $("[data-api-editor].active")?.dataset.apiEditor || "query",
            responseTab: $("[data-api-response].active")?.dataset.apiResponse || "body",
            wrap: $("#toggle-response-wrap").classList.contains("active"),
        },
        environmentId: state.activeApiEnvironmentId || "",
        response: state.apiResponse ? JSON.parse(JSON.stringify(state.apiResponse)) : null,
    };
    if (snapshot.response && state.apiResponseRequestKey && state.apiResponseRequestKey !== apiSnapshotRequestKey(snapshot)) {
        snapshot.response = null;
        if (!kind)
            snapshot.kind = "draft";
    }
    return snapshot;
}
async function preserveApiEditor() {
    const operation = state.apiHistoryWrite.then(async () => {
        for (const [id, snapshot] of state.apiHistoryFailedResponses) {
            await apiRequestHistory.record(snapshot, id);
            state.apiHistoryFailedResponses.delete(id);
        }
        const snapshot = captureApiRequestSnapshot(), key = apiSnapshotKey(snapshot);
        if (!apiSnapshotHasContent(snapshot) || key === state.apiHistoryLastKey)
            return false;
        await apiRequestHistory.record(snapshot);
        state.apiHistoryLastKey = key;
        return true;
    });
    state.apiHistoryWrite = operation.catch(() => { });
    return operation;
}
async function editApiRequest(request = null, { snapshot = null } = {}) {
    const transition = ++state.apiEditorTransition;
    try {
        let preserved = false;
        do {
            preserved = (await preserveApiEditor()) || preserved;
            if (transition !== state.apiEditorTransition)
                return false;
        } while (apiSnapshotHasContent(captureApiRequestSnapshot())
            && apiSnapshotKey(captureApiRequestSnapshot()) !== state.apiHistoryLastKey);
        applyApiRequest(request);
        state.apiEditorReady = true;
        state.apiEditorGeneration++;
        state.apiActiveSend = null;
        $("#send-api-request").disabled = false;
        $("#send-api-request").textContent = "Send";
        state.apiHistoryLastKey = null;
        if (snapshot) {
            restoreApiRequestSnapshot(snapshot);
            state.apiHistoryLastKey = apiSnapshotKey(captureApiRequestSnapshot());
        }
        else if (!request && preserved) {
            selectApiSidebar("history");
            toast("Previous request kept in History");
        }
        return true;
    }
    catch {
        toast("Could not preserve request history. Your current request is still here; try again before opening another.", "error");
        return false;
    }
}
function applyApiRequest(request = null) {
    state.activeApiRequest = request;
    const form = $("#api-request-form");
    form.reset();
    form.elements.id.value = request?.id || "";
    form.elements.name.value = request?.name || "";
    form.elements.method.value = request?.method || "GET";
    form.elements.url.dataset.template = request?.url || "";
    form.elements.url.value = request?.url || "";
    const queryParameters = request?.queryParams?.length ? request.queryParams : queryParametersFromUrl(request?.url || "");
    const headerParameters = requestParametersFromObject(request?.headers || {});
    form.elements.queryParamsText.value = JSON.stringify(requestParametersToObject(queryParameters), null, 2);
    form.elements.headersText.value = JSON.stringify(request?.headers || {}, null, 2);
    form.elements.body.value = request?.body || "";
    renderApiParameterRows("query", queryParameters);
    renderApiParameterRows("headers", headerParameters);
    setApiParameterView("query", "table", true);
    setApiParameterView("headers", "table", true);
    renderApiCollectionOptions(request?.collectionId || "");
    form.elements.collectionId.value = request?.collectionId || "";
    $("#delete-api-request").classList.toggle("hidden", !request?.id);
    $("#api-request-origin").textContent = request ? `Created by ${request.createdBy || "manual"}` : "Unsaved request";
    resetApiResponse();
    renderApiRequestList();
    showResolvedApiUrl();
}
function renderApiResponse(response) {
    resetApiResponse();
    if (!response)
        return;
    state.apiResponse = response;
    state.apiResponseRequestKey = apiSnapshotRequestKey(captureApiRequestSnapshot());
    $("#api-response-status").className = response.ok ? "success" : "error";
    $("#api-response-status").textContent = response.transportError ? "Request failed" : `${response.status} ${response.statusText || ""}`.trim();
    $("#api-response-meta").textContent = response.transportError ? "" : `${response.durationMs} ms · ${response.sizeBytes} bytes`;
    renderResponseContent($("#api-response-body"), response.transportError || response.body || "(empty response)", !response.transportError);
    if (!response.transportError)
        renderResponseContent($("#api-response-headers"), JSON.stringify(response.headers || {}, null, 2));
}
function restoreApiRequestSnapshot(snapshot) {
    const editor = snapshot.editor, form = $("#api-request-form");
    for (const [kind, rows, text, view] of [
        ["query", editor.queryRows, editor.queryText, editor.queryView],
        ["headers", editor.headerRows, editor.headersText, editor.headerView],
    ]) {
        renderApiParameterRows(kind, rows || []);
        apiParameterJsonInput(kind).value = text ?? "{}";
        const selectedView = view === "json" ? "json" : "table";
        $(`#api-${kind}-editor`).dataset.parameterView = selectedView;
        apiParameterContainer(kind).classList.toggle("hidden", selectedView !== "table");
        apiParameterJsonInput(kind).classList.toggle("hidden", selectedView !== "json");
        $$(`[data-api-parameter-view^="${kind}:"]`).forEach(button => button.classList.toggle("active", button.dataset.apiParameterView === `${kind}:${selectedView}`));
    }
    state.activeApiEnvironmentId = snapshot.environmentId || "";
    renderApiEnvironmentSelector();
    if (state.activeApiEnvironmentId)
        localStorage.setItem("argus-active-api-environment", state.activeApiEnvironmentId);
    const missingEnvironment = snapshot.environmentId && state.activeApiEnvironmentId !== snapshot.environmentId;
    for (const kind of ["query", "headers", "body"]) {
        const active = kind === editor.tab;
        $(`[data-api-editor="${kind}"]`).classList.toggle("active", active);
        $(`#api-${kind}-editor`).classList.toggle("hidden", !active);
    }
    form.elements.url.value = snapshot.request.url || "";
    form.elements.url.dataset.template = form.elements.url.value;
    renderApiUrlHighlight();
    renderApiResponse(snapshot.response);
    const headers = editor.responseTab === "headers";
    $("#api-response-body").classList.toggle("hidden", headers);
    $("#api-response-headers").classList.toggle("hidden", !headers);
    $$('[data-api-response]').forEach(button => button.classList.toggle("active", button.dataset.apiResponse === (headers ? "headers" : "body")));
    const wrap = editor.wrap !== false;
    $("#toggle-response-wrap").classList.toggle("active", wrap);
    $("#toggle-response-wrap").textContent = wrap ? "Wrap lines" : "No wrap";
    $$(".api-response-panel pre").forEach(element => element.classList.toggle("no-wrap", !wrap));
    $("#api-request-origin").textContent = `Restored from History · not sent${missingEnvironment ? " · original environment unavailable" : ""}`;
}
async function openApiHistoryEntry(id) {
    const transition = ++state.apiEditorTransition;
    try {
        const entry = await apiRequestHistory.load(id);
        if (transition !== state.apiEditorTransition)
            return;
        const request = { ...entry.snapshot.request };
        if (!state.apiRequests.some(item => item.id === request.id))
            delete request.id;
        if (!state.apiCollections.some(item => item.id === request.collectionId))
            request.collectionId = null;
        if (await editApiRequest(request, { snapshot: entry.snapshot })) {
            $("#api-client-drawer").classList.remove("api-history-open");
            $("#open-api-history").setAttribute("aria-expanded", "false");
            $("#api-request-form").elements.url.focus();
        }
    }
    catch {
        toast("Could not reopen this history entry. Your current request has not changed.", "error");
    }
}
async function deleteApiHistoryEntry(id) {
    if (state.apiHistoryPendingIds.has(id) || state.apiHistoryFailedResponses.has(id)) {
        toast("This request is still finishing or saving its response. Please try again once it is saved.");
        return;
    }
    if (!confirm("Remove this request from local History? Saved collections and the current editor will not change."))
        return;
    try {
        await apiRequestHistory.remove(id);
    }
    catch {
        toast("Could not remove the history entry", "error");
    }
}
function activeApiEnvironment() {
    return state.apiEnvironments.find((environment) => environment.id === state.activeApiEnvironmentId) || null;
}
function resolvedApiPreview(value, requestVariables = {}) {
    const variables = { ...(requestVariables || {}), ...(activeApiEnvironment()?.values || {}) };
    const index = new Map(Object.entries(variables).map(([key, variableValue]) => [String(key), variableValue]));
    const lookup = (key) => index.has(String(key).trim()) ? String(index.get(String(key).trim())) : null;
    const withResolvedOrigins = String(value || "").replace(/\b(https?):\/\/\{\{\s*([^{}]+?)\s*\}\}/gi, (match, scheme, key) => {
        const resolved = lookup(key);
        if (resolved == null)
            return match;
        return /^https?:\/\//i.test(resolved) ? resolved.replace(/\/+$/, "") : `${scheme}://${resolved.replace(/^\/+|\/+$/g, "")}`;
    });
    return withResolvedOrigins.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) => lookup(key) ?? match);
}
function ensureApiPreviewProtocol(value) {
    const url = String(value || "").trim();
    if (!url || /\{\{[^{}]+\}\}/.test(url) || /^https?:\/\//i.test(url))
        return url;
    if (url.startsWith("//"))
        return `https:${url}`;
    return /^(localhost|127(?:\.\d+){3}|\[::1\])(?::|\/|$)/i.test(url) ? `http://${url}` : `https://${url}`;
}
function renderApiUrlHighlight() {
    const input = $("#api-request-form").elements.url;
    const highlight = $("#api-url-highlight");
    const source = String(input.value || "");
    let cursor = 0;
    const pieces = [];
    for (const match of source.matchAll(/\{\{\s*[^{}]+?\s*\}\}/g)) {
        pieces.push(escapeHtml(source.slice(cursor, match.index)));
        pieces.push(`<mark>${escapeHtml(match[0])}</mark>`);
        cursor = match.index + match[0].length;
    }
    pieces.push(escapeHtml(source.slice(cursor)));
    highlight.innerHTML = pieces.join("") || "&nbsp;";
    highlight.scrollLeft = input.scrollLeft;
}
function showResolvedApiUrl() {
    const input = $("#api-request-form").elements.url;
    let queryParameters;
    try {
        queryParameters = apiParametersFromForm("query");
    }
    catch {
        queryParameters = queryParametersFromUrl(input.dataset.template ?? input.value);
    }
    const template = composeUrlWithQuery(input.dataset.template ?? input.value, queryParameters);
    input.dataset.template = template;
    const environmentResolved = resolvedApiPreview(template, state.activeApiRequest?.variables);
    const pathVariables = state.activeApiRequest?.pathVariables?.length ? state.activeApiRequest.pathVariables : pathVariablesFromUrl(template);
    const resolved = ensureApiPreviewProtocol(applyPathVariables(environmentResolved, pathVariables, (value) => resolvedApiPreview(value, state.activeApiRequest?.variables)));
    input.value = template;
    const environment = activeApiEnvironment();
    input.classList.toggle("resolved-environment-value", Boolean(environment && resolved !== template));
    input.title = environment && resolved !== template ? `Resolves using ${environment.name}: ${resolved}` : "";
    input.dataset.resolvedUrl = resolved;
    renderApiUrlHighlight();
}
function editApiUrlTemplate() {
    const input = $("#api-request-form").elements.url;
    input.value = input.dataset.template ?? input.value;
    input.classList.remove("resolved-environment-value");
    renderApiUrlHighlight();
}
function saveApiUrlTemplate() {
    const input = $("#api-request-form").elements.url;
    if (input.value === input.dataset.template) {
        renderApiUrlHighlight();
        return;
    }
    input.dataset.template = input.value;
    renderApiParameterRows("query", queryParametersFromUrl(input.value));
    syncApiParameterJson("query");
    showResolvedApiUrl();
}
function renderApiEnvironmentSelector() {
    const select = $("#api-environment-select");
    if (!state.apiEnvironments.some((environment) => environment.id === state.activeApiEnvironmentId)) {
        state.activeApiEnvironmentId = "";
        localStorage.removeItem("argus-active-api-environment");
    }
    select.innerHTML = `<option value="">No environment</option>${state.apiEnvironments.map((environment) => `<option value="${escapeHtml(environment.id)}">${escapeHtml(environment.name)}</option>`).join("")}`;
    select.value = state.activeApiEnvironmentId;
    const environment = activeApiEnvironment();
    select.title = environment ? `${environment.name} · ${Object.keys(environment.values || {}).length} variables` : "Requests use their saved values only";
    $(".api-environment-picker").classList.toggle("has-active-environment", Boolean(environment));
}
function selectApiEnvironment(id, announce = true) {
    state.activeApiEnvironmentId = String(id || "");
    if (state.activeApiEnvironmentId)
        localStorage.setItem("argus-active-api-environment", state.activeApiEnvironmentId);
    else
        localStorage.removeItem("argus-active-api-environment");
    renderApiEnvironmentSelector();
    renderApiRequestList();
    showResolvedApiUrl();
    resetApiResponse();
    if (announce)
        toast(activeApiEnvironment() ? `${activeApiEnvironment().name} environment selected` : "Environment variables disabled");
}
function renderApiEnvironmentList() {
    const list = $("#api-environment-list");
    if (!state.apiEnvironments.length) {
        list.innerHTML = `<div class="api-environment-empty"><strong>No environments yet</strong><small>Create Local, QA, or Production variables here.</small></div>`;
        return;
    }
    list.innerHTML = state.apiEnvironments.map((environment) => `<button type="button" data-api-environment-id="${escapeHtml(environment.id)}" class="${environment.id === state.editingApiEnvironmentId ? "selected" : ""}"><span class="status-dot"></span><span><strong>${escapeHtml(environment.name)}</strong><small>${Object.keys(environment.values || {}).length} variable${Object.keys(environment.values || {}).length === 1 ? "" : "s"}${environment.id === state.activeApiEnvironmentId ? " · active" : ""}</small></span></button>`).join("");
}
async function editApiEnvironment(environment = null) {
    const form = $("#api-environment-form");
    form.reset();
    state.editingApiEnvironmentId = environment?.id || null;
    let editable = environment;
    if (environment?.id)
        editable = await api(`/api/api-environments/${environment.id}`);
    form.elements.id.value = editable?.id || "";
    form.elements.name.value = editable?.name || "";
    form.elements.valuesText.value = editable?.valuesText || "";
    $("#delete-api-environment").classList.toggle("hidden", !editable?.id);
    $("#export-api-environment").classList.toggle("hidden", !editable?.id);
    renderApiEnvironmentList();
    setTimeout(() => form.elements.name.focus(), 30);
}
async function refreshApiEnvironments() {
    state.apiEnvironments = await api("/api/api-environments");
    renderApiEnvironmentSelector();
    renderApiEnvironmentList();
}
async function openApiEnvironmentDialog() {
    showAppDialog("api-environment-dialog");
    try {
        await refreshApiEnvironments();
        await editApiEnvironment(activeApiEnvironment() || state.apiEnvironments[0] || null);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function saveApiEnvironment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
        const environment = await api("/api/api-environments", { method: "POST", body: {
                id: form.elements.id.value || undefined,
                name: form.elements.name.value.trim(),
                valuesText: form.elements.valuesText.value,
            } });
        await refreshApiEnvironments();
        selectApiEnvironment(environment.id, false);
        await editApiEnvironment(state.apiEnvironments.find((item) => item.id === environment.id));
        toast(`${environment.name} saved and selected`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function importApiEnvironment() {
    try {
        const result = await api("/api/api-environments/import-file", { method: "POST" });
        if (result.cancelled)
            return;
        await refreshApiEnvironments();
        selectApiEnvironment(result.environment.id, false);
        await editApiEnvironment(state.apiEnvironments.find((item) => item.id === result.environment.id));
        toast(`${result.environment.name} imported and selected`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function exportApiEnvironment() {
    if (!state.editingApiEnvironmentId)
        return;
    try {
        const result = await api(`/api/api-environments/${state.editingApiEnvironmentId}/export`, { method: "POST" });
        if (!result.cancelled)
            toast(`${result.environment.name} exported for Postman`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function deleteApiEnvironment() {
    const environment = state.apiEnvironments.find((item) => item.id === state.editingApiEnvironmentId);
    if (!environment || !confirm(`Delete the ${environment.name} environment?`))
        return;
    try {
        await api(`/api/api-environments/${environment.id}`, { method: "DELETE" });
        if (state.activeApiEnvironmentId === environment.id)
            selectApiEnvironment("", false);
        await refreshApiEnvironments();
        await editApiEnvironment(state.apiEnvironments[0] || null);
        toast(`${environment.name} environment deleted`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function openApiClient() {
    switchPrimaryView("api");
    void refreshApiRequestHistory();
    setRefreshLoading($("#refresh-api-client"), true);
    $("#api-request-list").innerHTML = skeletonRows(6);
    try {
        const [requests, collections, location, environments] = await Promise.all([
            api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests`),
            api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-collections`),
            api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests/location`),
            api("/api/api-environments"),
        ]);
        state.apiRequests = requests;
        state.apiCollections = collections;
        state.apiEnvironments = environments;
        renderApiEnvironmentSelector();
        $("#api-storage-location").textContent = "Documents · local files";
        $("#api-storage-location").title = location.path;
        if (!state.apiEditorReady && !apiSnapshotHasContent(captureApiRequestSnapshot()))
            await editApiRequest(state.apiRequests[0] || null);
        else {
            state.apiEditorReady = true;
            renderApiRequestList();
        }
    }
    catch (error) {
        $("#api-request-list").innerHTML = `<div class="empty-list">Could not load saved requests.</div>`;
        toast(error.message, "error");
    }
    finally {
        setRefreshLoading($("#refresh-api-client"), false);
    }
}
function headersFromForm() {
    return requestParametersToObject(apiParametersFromForm("headers"));
}
function apiRequestFromForm() {
    const form = $("#api-request-form");
    const urlInput = form.elements.url;
    const body = form.elements.body.value;
    const postman = state.activeApiRequest?.postman
        ? { ...state.activeApiRequest.postman, body: body === state.activeApiRequest.body ? state.activeApiRequest.postman.body : null }
        : null;
    const queryParams = apiParametersFromForm("query");
    const pathVariables = state.activeApiRequest?.pathVariables?.length
        ? state.activeApiRequest.pathVariables
        : pathVariablesFromUrl(urlInput.dataset.template ?? urlInput.value);
    const templateUrl = (document.activeElement === urlInput ? urlInput.value : (urlInput.dataset.template ?? urlInput.value)).trim();
    return {
        id: form.elements.id.value || undefined,
        repositoryId: API_CLIENT_REPOSITORY_ID,
        runConfigurationId: null,
        collectionId: form.elements.collectionId.value || null,
        name: form.elements.name.value.trim(), method: form.elements.method.value,
        url: composeUrlWithQuery(templateUrl, queryParams), queryParams, pathVariables, headers: headersFromForm(), body,
        description: state.activeApiRequest?.description || "", variables: state.activeApiRequest?.variables || {}, postman,
        createdBy: state.activeApiRequest?.createdBy || "manual",
    };
}
async function saveApiRequest() {
    try {
        const request = apiRequestFromForm();
        if (!request.name || !request.url)
            throw new Error("Request name and URL are required");
        if (!request.collectionId) {
            alert("Collection select kar le bhai pehle. You can Send this request without saving, but saved requests must belong to a collection.");
            return;
        }
        const copiedToAnotherCollection = Boolean(state.activeApiRequest?.id
            && (state.activeApiRequest.collectionId || null) !== (request.collectionId || null));
        if (copiedToAnotherCollection)
            request.id = undefined;
        const generation = state.apiEditorGeneration;
        const saved = await api("/api/api-requests", { method: "POST", body: request });
        state.apiRequests = await api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests`);
        if (generation === state.apiEditorGeneration)
            await editApiRequest(state.apiRequests.find((item) => item.id === saved.id) || saved);
        else
            renderApiRequestList();
        toast(copiedToAnotherCollection
            ? "Saved as a new request in the selected collection; the original was kept"
            : "Saved locally as JSON and cURL in Documents");
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function openApiCollectionDialog() {
    const form = $("#api-collection-form");
    form.reset();
    showAppDialog("api-collection-dialog");
    setTimeout(() => form.elements.name.focus(), 30);
}
async function createApiCollection(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
        const collection = await api("/api/api-collections", { method: "POST", body: {
                repositoryId: API_CLIENT_REPOSITORY_ID,
                runConfigurationId: null,
                name: form.get("name"),
            } });
        state.apiCollections = await api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-collections`);
        $("#api-collection-dialog").close();
        renderApiRequestList();
        $("#api-request-collection").innerHTML = collectionOptions(collection.id);
        $("#api-request-collection").value = collection.id;
        toast(`Collection “${collection.name}” is ready`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function importApiFile() {
    try {
        const result = await api("/api/api-requests/import-file", { method: "POST", body: { repositoryId: API_CLIENT_REPOSITORY_ID } });
        if (result.cancelled)
            return;
        [state.apiRequests, state.apiCollections] = await Promise.all([
            api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests`),
            api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-collections`),
        ]);
        await editApiRequest(result.imported?.[0] || state.apiRequests[0] || null);
        toast(`${result.count} request${result.count === 1 ? "" : "s"} and ${result.collectionCount || 0} collection${result.collectionCount === 1 ? "" : "s"} imported`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function exportApiFile() {
    try {
        const result = await api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests/export`, { method: "POST" });
        if (!result.cancelled)
            toast(`${result.count} requests in ${result.collectionCount || 0} collections exported to ${result.path}`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function openApiFolder() {
    try {
        await api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests/open-folder`, { method: "POST" });
    }
    catch (error) {
        toast(error.message, "error");
    }
}
function beautifyRequestPart(part) {
    const element = $("#api-request-form").elements[part === "headers" ? "headersText" : "body"];
    try {
        element.value = formatJson(element.value || (part === "headers" ? "{}" : "null"));
    }
    catch {
        toast(`${part === "headers" ? "Headers" : "Body"} is not valid JSON`, "error");
    }
}
function bindApiResizers() {
    const sidebarHandle = $("#api-sidebar-resizer");
    const paneHandle = $("#api-pane-resizer");
    const beginDrag = (handle, move) => handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        handle.classList.add("dragging");
        document.body.style.userSelect = "none";
        const onMove = (moveEvent) => move(moveEvent);
        const onUp = () => {
            handle.classList.remove("dragging");
            document.body.style.userSelect = "";
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp, { once: true });
    });
    beginDrag(sidebarHandle, (event) => {
        const layout = $(".api-client-layout");
        const bounds = layout.getBoundingClientRect();
        layout.style.setProperty("--api-sidebar-width", `${Math.max(180, Math.min(520, event.clientX - bounds.left))}px`);
    });
    beginDrag(paneHandle, (event) => {
        const workbench = $(".api-request-workbench");
        const bounds = workbench.getBoundingClientRect();
        const height = Math.max(250, Math.min(bounds.height - 160, event.clientY - bounds.top));
        workbench.style.setProperty("--api-request-height", `${height}px`);
    });
}
function bindWorkspaceResizer() {
    setupGitPanelResize({ document, window });
}
function bindTaskResizers() {
    const bind = (handle, container, property, storageKey, minimum, maximum) => {
        if (!handle || !container)
            return;
        const saved = Number(localStorage.getItem(storageKey));
        if (saved)
            container.style.setProperty(property, `${saved}px`);
        handle.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            handle.classList.add("dragging");
            document.body.style.userSelect = "none";
            const bounds = container.getBoundingClientRect();
            const onMove = (moveEvent) => container.style.setProperty(property, `${Math.max(minimum, Math.min(maximum, moveEvent.clientX - bounds.left))}px`);
            const onUp = () => {
                const width = Math.round(parseFloat(getComputedStyle(container).getPropertyValue(property)) || minimum);
                localStorage.setItem(storageKey, String(width));
                handle.classList.remove("dragging");
                document.body.style.userSelect = "";
                window.removeEventListener("pointermove", onMove);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp, { once: true });
        });
    };
    bind($("#repository-task-resizer"), $(".ai-canvas"), "--task-panel-width", "argus-repository-task-width", 170, 360);
    bind($("#global-task-resizer"), $(".global-codex-layout"), "--global-task-panel-width", "argus-global-task-width", 210, 390);
}
function selectOnlyResponseContent(event) {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a")
        return;
    event.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(event.currentTarget);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}
async function sendApiRequest(event) {
    event.preventDefault();
    if (state.apiActiveSend)
        return;
    const sending = { generation: state.apiEditorGeneration };
    let historyId;
    try {
        const request = apiRequestFromForm();
        if (!request.url)
            throw new Error("Request URL is required");
        const snapshot = JSON.parse(JSON.stringify(captureApiRequestSnapshot("sent")));
        snapshot.response = null;
        state.apiActiveSend = sending;
        const button = $("#send-api-request");
        button.disabled = true;
        button.textContent = "Sending…";
        if (state.apiResponse)
            await preserveApiEditor();
        let entry;
        try {
            entry = await apiRequestHistory.record(snapshot);
        }
        catch {
            throw new Error("Could not save request history. Nothing was sent; your request is still here.");
        }
        historyId = entry.id;
        state.apiHistoryPendingIds.add(historyId);
        if (state.apiActiveSend === sending) {
            resetApiResponse();
            $("#api-response-status").textContent = "Waiting…";
        }
        try {
            snapshot.response = await api("/api/api-requests/send", { method: "POST", body: { ...request, environmentId: snapshot.environmentId || null } });
        }
        catch (error) {
            snapshot.kind = "failed";
            snapshot.response = { transportError: error.message };
        }
        if (state.apiActiveSend === sending) {
            if (apiSnapshotRequestKey(captureApiRequestSnapshot()) === apiSnapshotRequestKey(snapshot))
                renderApiResponse(snapshot.response);
            else {
                resetApiResponse();
                $("#api-response-status").textContent = "Request changed";
                renderResponseContent($("#api-response-body"), "This response belongs to the earlier request. Open it from History.", false);
            }
        }
        try {
            await apiRequestHistory.record(snapshot, entry.id);
            if (state.apiActiveSend === sending && apiSnapshotKey(captureApiRequestSnapshot()) === apiSnapshotKey(snapshot)) {
                state.apiHistoryLastKey = apiSnapshotKey(snapshot);
            }
        }
        catch {
            state.apiHistoryFailedResponses.set(entry.id, snapshot);
            toast("Request is in History, but its response could not be saved yet. It is kept in memory and will be retried before you change requests.", "error");
        }
    }
    catch (error) {
        toast(error.message, "error");
    }
    finally {
        if (historyId)
            state.apiHistoryPendingIds.delete(historyId);
        if (state.apiActiveSend === sending) {
            state.apiActiveSend = null;
            $("#send-api-request").disabled = false;
            $("#send-api-request").textContent = "Send";
        }
    }
}
async function copyApiCurl() {
    try {
        const request = apiRequestFromForm();
        if (!request.url)
            throw new Error("Request URL is required");
        const result = await api("/api/api-requests/curl", { method: "POST", body: { ...request, environmentId: state.activeApiEnvironmentId || null } });
        await navigator.clipboard.writeText(result.curl);
        toast(`Resolved cURL copied${result.environmentName ? ` using ${result.environmentName}` : ""}`);
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function importCurl(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
        const collectionId = form.get("collectionId") || null;
        const request = await api("/api/api-requests/import-curl", { method: "POST", body: { repositoryId: API_CLIENT_REPOSITORY_ID, runConfigurationId: null, collectionId, curl: form.get("curl"), save: Boolean(collectionId) } });
        if (collectionId)
            state.apiRequests = await api(`/api/repositories/${API_CLIENT_REPOSITORY_ID}/api-requests`);
        $("#curl-dialog").close();
        if (!await editApiRequest(collectionId ? state.apiRequests.find((item) => item.id === request.id) : { ...request, collectionId: null, createdBy: "curl" }))
            return;
        toast(collectionId ? "cURL imported and ready to send" : "cURL prepared without saving · choose a collection when you want to save it");
    }
    catch (error) {
        toast(error.message, "error");
    }
}
async function importCurlFromUrlPaste(event) {
    const pasted = String(event.clipboardData?.getData("text/plain") || "").trim();
    if (!/^curl(?:\s|$)/i.test(pasted))
        return;
    event.preventDefault();
    const form = $("#api-request-form");
    const collectionId = form.elements.collectionId.value || state.activeApiRequest?.collectionId || null;
    try {
        const request = await api("/api/api-requests/import-curl", {
            method: "POST",
            body: { repositoryId: API_CLIENT_REPOSITORY_ID, runConfigurationId: null, curl: pasted, save: false },
        });
        if (!await editApiRequest({ ...request, id: undefined, collectionId, createdBy: "curl" }))
            return;
        form.elements.url.focus();
        toast("cURL detected · method, URL, query, headers, and body prepared");
    }
    catch (error) {
        toast(`Could not import cURL: ${error.message}`, "error");
    }
}
async function importAgentApiRequests(job, { isCurrent = () => true } = {}) {
    if (!job?.apiRequestSuggestions?.length || state.importedAgentJobs.has(job.id))
        return;
    state.importedAgentJobs.add(job.id);
    let imported = 0;
    let preparedRequest = null;
    for (const suggestion of job.apiRequestSuggestions) {
        try {
            if (suggestion.curl) {
                preparedRequest = await api("/api/api-requests/import-curl", { method: "POST", body: { repositoryId: API_CLIENT_REPOSITORY_ID, curl: suggestion.curl, createdBy: "ai", save: false } });
            }
            else {
                preparedRequest = { ...suggestion, repositoryId: API_CLIENT_REPOSITORY_ID, runConfigurationId: null, collectionId: null, createdBy: "ai" };
            }
            imported += 1;
        }
        catch (error) {
            toast(`AI request could not be imported: ${error.message}`, "error");
        }
    }
    if (preparedRequest && isCurrent())
        await editApiRequest(preparedRequest);
    if (imported && isCurrent())
        toast(`${imported} API request${imported === 1 ? "" : "s"} prepared by AI · choose a collection to save`);
}
let repositoryTerminal;
function getRepositoryTerminal() {
    repositoryTerminal ||= createRepositoryTerminal({ document, api, getRepository: () => state.activeRepository, notify: toast,
        onVisibilityChange: snapshot => repositoryIdeBridge.syncTerminalState(snapshot) });
    return repositoryTerminal;
}
async function openTerminal({ repositoryId = state.activeRepository?.id, returnFocus } = {}) {
    if (state.currentView !== "repository" || !repositoryIdeBridge.isVisible(repositoryId))
        return;
    return getRepositoryTerminal().open({ repositoryId, returnFocus: returnFocus || (() => $('.repository-ide-tool-tab[data-tool="terminal"]')) });
}
function mountIdeTerminal(host, { repositoryId } = {}) {
    if (!host) {
        repositoryTerminal?.minimize({ restoreFocus: false });
        if (repositoryTerminal)
            repositoryTerminal.mount(document.body);
        return;
    }
    if (state.activeRepository?.id !== repositoryId)
        return;
    getRepositoryTerminal().mount(host);
    repositoryIdeBridge.syncTerminalState(repositoryTerminal.getState());
}
async function toggleIdeTerminal(options) {
    if (!repositoryIdeBridge.isVisible(options.repositoryId))
        return;
    if (repositoryTerminal?.getState().visible)
        repositoryTerminal.minimize();
    else
        await openTerminal(options);
}
function minimizeTerminal() { return getRepositoryTerminal().minimize(); }
async function closeTerminal() { return getRepositoryTerminal().close(); }
async function clearTerminal() { return getRepositoryTerminal().clear(); }
async function restartTerminal() { return getRepositoryTerminal().restart(); }
function bindTerminalResizer() {
    const resizer = $("#terminal-resizer");
    resizer.addEventListener("pointerdown", (event) => {
        if ($("#terminal-panel").closest(".repository-ide-tool-dock"))
            return;
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        const startY = event.clientY;
        const startHeight = $("#terminal-panel").getBoundingClientRect().height;
        const move = (moveEvent) => {
            const dock = $("#terminal-panel").closest(".repository-ide-main");
            const slot = $("#terminal-panel").closest(".repository-ide-terminal-slot");
            const maximum = dock ? Math.max(100, dock.clientHeight * .45) : window.innerHeight - 90;
            const height = Math.max(Math.min(140, maximum), Math.min(maximum, startHeight + startY - moveEvent.clientY));
            if (slot)
                slot.style.flexBasis = `${height}px`;
            else
                $("#terminal-panel").style.height = `${height}px`;
            localStorage.setItem("argus-terminal-height", String(height));
        };
        const up = () => { resizer.removeEventListener("pointermove", move); resizer.removeEventListener("pointerup", up); };
        resizer.addEventListener("pointermove", move);
        resizer.addEventListener("pointerup", up);
    });
    const savedHeight = Number(localStorage.getItem("argus-terminal-height"));
    if (savedHeight >= 230)
        $("#terminal-panel").style.height = `${Math.min(savedHeight, window.innerHeight - 90)}px`;
}
function bindEvents() {
    document.addEventListener("pointerdown", cancelPendingAppNavigation, true);
    document.addEventListener("keydown", cancelPendingAppNavigation, true);
    document.addEventListener("argus-ide-user-activity", cancelPendingAppNavigation);
    window.addEventListener("popstate", (event) => { cancelPendingAppNavigation(event); void restoreRoute(); });
    $("#app-navigation-back").addEventListener("click", () => void moveAppNavigation(-1));
    $("#app-navigation-forward").addEventListener("click", () => void moveAppNavigation(1));
    $("#brand-home").addEventListener("click", (event) => {
        event.preventDefault();
        switchPrimaryView("repository");
    });
    $("#theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
    $$('[data-font-size]').forEach((button) => button.addEventListener("click", () => applyFontSize(button.dataset.fontSize)));
    bindWorkspaceToolsMenu();
    $("#workspace-task-rail-toggle").addEventListener("click", () => {
        const scope = activeTaskPanelScope();
        if (!scope)
            return;
        const container = scope === "global" ? $(".global-codex-layout") : $(".ai-canvas");
        const view = scope === "global" ? "global" : "repository";
        const switchingToTasks = state.currentView !== view
            || document.body.classList.contains("workspace-tool-active")
            || document.body.classList.contains("version-control-dock-open");
        const wasCollapsed = container.classList.contains("task-panel-collapsed");
        if (!showTaskWorkspace(scope))
            return;
        setTaskPanelCollapsed(scope, switchingToTasks ? false : !wasCollapsed);
    });
    $("#close-git-panel").addEventListener("click", () => {
        setVersionControlDockOpen(false);
        $("#repository-ide-version-control-toggle")?.focus({ preventScroll: true });
    });
    $$('[data-task-panel-toggle]').forEach((button) => button.addEventListener("click", () => {
        const scope = button.dataset.taskPanelToggle;
        const container = scope === "global" ? $(".global-codex-layout") : $(".ai-canvas");
        setTaskPanelCollapsed(scope, !container.classList.contains("task-panel-collapsed"));
    }));
    document.addEventListener("click", (event) => {
        const copyCode = event.target.closest("[data-copy-chat-code]");
        if (copyCode) {
            const code = copyCode.closest(".chat-code-block")?.querySelector("code")?.textContent || "";
            navigator.clipboard.writeText(code).then(() => {
                copyCode.textContent = "Copied";
                setTimeout(() => { copyCode.textContent = "Copy"; }, 1200);
            }).catch(() => toast("Could not copy the code block", "error"));
        }
    });
    $("#backup-toggle").addEventListener("click", () => launchWorkspaceTool(openBackupDialog));
    $("#data-storage-toggle").addEventListener("click", () => launchWorkspaceTool(openDataStorageDialog));
    $("#json-explorer-toggle").addEventListener("click", () => launchWorkspaceTool(openJsonExplorer));
    $("#diagram-studio-rail-toggle").addEventListener("click", () => launchWorkspaceTool(() => switchPrimaryView("diagrams")));
    $("#data-storage-dialog").addEventListener("click", handleDataStorageAction);
    $("#terminal-minimize").addEventListener("click", minimizeTerminal);
    $("#terminal-close").addEventListener("click", closeTerminal);
    $("#terminal-clear").addEventListener("click", clearTerminal);
    $("#terminal-restart").addEventListener("click", restartTerminal);
    document.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.code === "Backquote") {
            if (state.currentView !== "repository" || !repositoryIdeBridge.isVisible(state.activeRepository?.id))
                return;
            event.preventDefault();
            if ($("#terminal-panel").classList.contains("hidden"))
                openTerminal();
            else
                minimizeTerminal();
        }
    });
    $("#project-structure-toggle").addEventListener("click", openProjectStructure);
    $("#refresh-project-structure").addEventListener("click", openProjectStructure);
    $("#save-project-structure").addEventListener("click", saveProjectStructure);
    $("#project-structure-dialog").addEventListener("click", (event) => {
        const section = event.target.closest("[data-project-section]");
        if (section)
            switchProjectStructureSection(section.dataset.projectSection);
        const sdk = event.target.closest("[data-java-home]");
        if (sdk) {
            $("#java-project-sdk").value = sdk.dataset.javaHome;
            $$(".java-sdk-card").forEach((card) => card.classList.toggle("selected", card === sdk));
            $$(".java-sdk-card .sdk-selected-indicator").forEach((label) => { label.textContent = label.closest(".java-sdk-card") === sdk ? "Selected" : "Use SDK"; });
        }
    });
    $("#refresh-backup-status").addEventListener("click", refreshBackupStatus);
    $("#retry-backup-status").addEventListener("click", refreshBackupStatus);
    $("#choose-backup-folder").addEventListener("click", chooseBackupFolder);
    $("#toggle-backup-preview").addEventListener("click", toggleBackupPreview);
    $("#save-argus-backup").addEventListener("click", openBackupConfirmation);
    $("#backup-confirm-submit").addEventListener("click", saveArgusChanges);
    $("#backup-confirm-back").addEventListener("click", openBackupDialog);
    $("#backup-confirm-done").addEventListener("click", () => $("#backup-confirm-dialog").close());
    $("#backup-repository-url").addEventListener("input", () => { state.backupDraftRepositoryUrl = $("#backup-repository-url").value; updateBackupFormValidity(); });
    $("#backup-passphrase").addEventListener("input", updateBackupFormValidity);
    $("#restore-argus-backup").addEventListener("click", restoreArgusBackup);
    $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
    $("#repo-tabs").addEventListener("click", (event) => {
        const group = event.target.closest("[data-toggle-tab-group]");
        if (group)
            return toggleRepositoryTabGroup(group.dataset.toggleTabGroup);
        const tab = event.target.closest("[data-repository-id]");
        if (tab)
            activateRepository(tab.dataset.repositoryId);
    });
    $("#repo-tabs").addEventListener("click", (event) => { const close = event.target.closest("[data-close-repository]"); if (close)
        openCloseRepositoryDialog(close.dataset.closeRepository); });
    $("#repo-offboard").addEventListener("click", () => openRepositoryOffboarding());
    $("#offboard-repository-list").addEventListener("change", (event) => {
        const input = event.target.closest('input[name="offboardRepository"]');
        if (!input)
            return;
        if (input.checked)
            state.pendingOffboardingIds.add(input.value);
        else
            state.pendingOffboardingIds.delete(input.value);
        renderRepositoryOffboarding();
    });
    $("#offboard-confirmation").addEventListener("input", renderRepositoryOffboarding);
    $("#repo-tabs").addEventListener("contextmenu", (event) => {
        const group = event.target.closest("[data-tab-group]");
        const block = event.target.closest("[data-tab-group-block]");
        const tab = event.target.closest("[data-repository-tab]");
        if (!group && !tab && !block)
            return;
        event.preventDefault();
        openRepositoryTabGroupDialog(group?.dataset.tabGroup || block?.dataset.tabGroupBlock || null, tab?.dataset.repositoryTab || null);
    });
    $("#repo-tabs").addEventListener("scroll", updateRepositoryTabOverflow, { passive: true });
    $("#repo-tabs").addEventListener("wheel", (event) => {
        const tabs = $("#repo-tabs");
        const delta = repositoryTabWheelDelta(event, tabs);
        if (!delta)
            return;
        event.preventDefault();
        tabs.scrollLeft += delta;
    }, { passive: false });
    $("#repo-tabs").addEventListener("keydown", (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            return;
        const buttons = [...$("#repo-tabs").querySelectorAll("[data-repository-id], [data-toggle-tab-group]")];
        const focused = event.target.closest("[data-repository-id], [data-toggle-tab-group]");
        const tab = event.target.closest("[data-repository-tab]");
        const index = buttons.findIndex((button) => button === focused || (tab && button.dataset.repositoryId === tab.dataset.repositoryTab));
        const next = repositoryTabFocusIndex(index, event.key, buttons.length);
        if (next === null)
            return;
        event.preventDefault();
        buttons[next].focus({ preventScroll: true });
        revealRepositoryTab(buttons[next].closest("[data-repository-tab], [data-toggle-tab-group]"));
    });
    $("#repo-tabs-scroll-left").addEventListener("click", () => $("#repo-tabs").scrollBy({ left: -Math.max(240, $("#repo-tabs").clientWidth * .65), behavior: repositoryTabScrollBehavior() }));
    $("#repo-tabs-scroll-right").addEventListener("click", () => $("#repo-tabs").scrollBy({ left: Math.max(240, $("#repo-tabs").clientWidth * .65), behavior: repositoryTabScrollBehavior() }));
    window.addEventListener("resize", updateRepositoryTabOverflow, { passive: true });
    new ResizeObserver(updateRepositoryTabOverflow).observe($("#repo-tab-rail"));
    const tabToolsMenu = $("#repository-tab-tools-menu");
    tabToolsMenu.addEventListener("toggle", () => {
        $("#repository-tab-tools-toggle").setAttribute("aria-expanded", String(tabToolsMenu.matches(":popover-open")));
        positionRepositoryTabTools();
    });
    window.addEventListener("resize", positionRepositoryTabTools, { passive: true });
    new ResizeObserver(positionRepositoryTabTools).observe(tabToolsMenu);
    tabToolsMenu.addEventListener("keydown", (event) => {
        if (event.key !== "Escape")
            return;
        event.preventDefault();
        closeRepositoryTabTools();
        $("#repository-tab-tools-toggle").focus();
    });
    $("#repository-tab-tools-groups").addEventListener("click", (event) => {
        const toggle = event.target.closest("[data-toggle-tab-group]");
        if (toggle)
            return toggleRepositoryTabGroup(toggle.dataset.toggleTabGroup);
        const edit = event.target.closest("[data-edit-tab-group]");
        if (edit) {
            closeRepositoryTabTools();
            openRepositoryTabGroupDialog(edit.dataset.editTabGroup);
        }
    });
    $("#manage-repositories").addEventListener("click", openRepositoryManager);
    $("#repository-manager-search").addEventListener("input", renderRepositoryManager);
    $("#repository-manager-list").addEventListener("click", (event) => {
        const open = event.target.closest("[data-open-managed-repository]");
        if (open)
            return activateRepository(open.dataset.openManagedRepository);
        const offboard = event.target.closest("[data-offboard-managed-repository]");
        if (offboard)
            openCloseRepositoryDialog(offboard.dataset.offboardManagedRepository);
    });
    $("#ai-status-pill").addEventListener("click", () => launchWorkspaceTool(() => { refreshBrowserPairingStatus({ silent: true }); showAppDialog("ai-connections-dialog"); renderAIConnections(); }));
    $("#ai-connection-list").addEventListener("click", (event) => {
        const refresh = event.target.closest("[data-refresh-ai-provider]");
        if (refresh)
            refreshConfiguredAiProvider(refresh.dataset.refreshAiProvider);
    });
    $("#refresh-ai-connections").addEventListener("click", refreshAIConnections);
    $("#start-browser-pairing").addEventListener("click", startBrowserPairing);
    $("#close-repo-form").addEventListener("submit", closeRepositoryTab);
    const showRepositoryChooser = () => {
        closeRepositoryTabTools();
        if (state.repositoryCloneBusy || state.cloneDestinationChoosing || state.folderDiscoveryBusy || state.onboardingSubmitting) {
            showAppDialog("repo-dialog");
            return;
        }
        if (!switchPrimaryView("repository"))
            return;
        state.repositoryCloneJobId = null;
        $("#repo-path").value = "";
        $("#chosen-repo-path").textContent = "No folders selected";
        $("#repo-clone-url").value = "";
        $("#clone-destination").value = "";
        $("#clone-destination-path").textContent = "No destination selected";
        $("#clone-repository-status").textContent = "";
        $("#clone-repository-status").classList.remove("error");
        $("#clone-repository").disabled = true;
        state.pendingOnboardingRepositories = [];
        renderProductionBranchSelection();
        $("#confirm-repo").disabled = true;
        document.querySelector('[data-onboarding-mode="local"]').click();
        showAppDialog("repo-dialog");
        void refreshCloneHistory();
        void refreshOnboardingPrerequisites();
    };
    $("#add-repo").addEventListener("click", showRepositoryChooser);
    $("#repo-groups").addEventListener("click", () => { closeRepositoryTabTools(); openRepositoryTabGroupDialog(); });
    $("#repo-group-form").addEventListener("submit", saveRepositoryTabGroup);
    $("#repo-group-list").addEventListener("click", (event) => {
        const group = event.target.closest("[data-edit-tab-group]");
        if (!group)
            return;
        state.editingRepositoryTabGroupId = group.dataset.editTabGroup;
        renderRepositoryTabGroupEditor();
    });
    $("#new-repo-group").addEventListener("click", () => {
        state.editingRepositoryTabGroupId = null;
        renderRepositoryTabGroupEditor();
        $("#repo-group-name").focus();
    });
    $("#delete-repo-group").addEventListener("click", deleteRepositoryTabGroup);
    $$('[data-open-repo]').forEach((button) => button.addEventListener("click", showRepositoryChooser));
    $$('[data-onboarding-mode]').forEach((button) => button.addEventListener("click", () => {
        if (state.repositoryCloneBusy || state.cloneDestinationChoosing || state.onboardingSubmitting)
            return;
        state.folderDiscoveryRevision++;
        state.folderDiscoveryBusy = false;
        $("#choose-repo-folder").disabled = false;
        $("#chosen-repo-path").textContent = "No folders selected";
        $$('[data-onboarding-mode]').forEach((item) => {
            const active = item === button;
            item.classList.toggle("active", active);
            item.setAttribute("aria-selected", String(active));
        });
        const cloneMode = button.dataset.onboardingMode === "clone";
        $("#repo-local-source").classList.toggle("hidden", cloneMode);
        $("#repo-clone-source").classList.toggle("hidden", !cloneMode);
        $("#repo-path").value = "";
        state.pendingOnboardingRepositories = [];
        renderProductionBranchSelection();
        if (cloneMode)
            $("#repo-clone-url").focus();
    }));
    $("#choose-repo-folder").addEventListener("click", async () => {
        if (state.folderDiscoveryBusy || state.onboardingSubmitting)
            return;
        const revision = ++state.folderDiscoveryRevision;
        const button = $("#choose-repo-folder");
        const previousLabel = $("#chosen-repo-path").textContent;
        let selectionCompleted = false;
        state.folderDiscoveryBusy = true;
        button.disabled = true;
        renderProductionBranchSelection();
        $("#chosen-repo-path").textContent = "Finder is open — choose a folder…";
        try {
            const result = await api("/api/system/select-folder", { method: "POST" });
            if (revision !== state.folderDiscoveryRevision)
                return;
            if (result.cancelled) {
                $("#chosen-repo-path").textContent = previousLabel;
                return;
            }
            selectionCompleted = true;
            const paths = result.paths?.length ? result.paths : [result.path].filter(Boolean);
            state.pendingOnboardingRepositories = [];
            $("#repo-path").value = JSON.stringify(paths);
            renderProductionBranchSelection();
            $("#chosen-repo-path").textContent = "Finding Git repositories and branches…";
            const discovered = await api("/api/repository-onboarding/discover", { method: "POST", body: { paths } });
            if (revision !== state.folderDiscoveryRevision)
                return;
            state.pendingOnboardingRepositories = discovered.repositories || [];
            $("#chosen-repo-path").textContent = state.pendingOnboardingRepositories.length
                ? `${state.pendingOnboardingRepositories.length} ${state.pendingOnboardingRepositories.length === 1 ? "repository" : "repositories"} found — review below`
                : "No Git repositories found. Choose a Git checkout with an initial commit.";
            renderProductionBranchSelection();
        }
        catch (error) {
            if (revision !== state.folderDiscoveryRevision)
                return;
            $("#chosen-repo-path").textContent = selectionCompleted ? error.message : previousLabel;
            toast(error.message, "error");
        }
        finally {
            if (revision === state.folderDiscoveryRevision) {
                state.folderDiscoveryBusy = false;
                button.disabled = false;
                renderProductionBranchSelection();
            }
        }
    });
    $("#repo-dialog").addEventListener("close", () => {
        state.folderDiscoveryRevision++;
        state.folderDiscoveryBusy = false;
        $("#choose-repo-folder").disabled = false;
        renderProductionBranchSelection();
    });
    const updateCloneButton = () => {
        $("#clone-repository").disabled = Boolean(state.repositoryCloneBusy || state.cloneDestinationChoosing)
            || !$("#repo-clone-url").value.trim() || !$("#clone-destination").value;
        $("#clone-repository").textContent = state.repositoryCloneBusy ? "Cloning…" : state.repositoryCloneJobId ? "Resume status" : "Clone repository";
    };
    const clearCloneSelection = () => {
        state.repositoryCloneJobId = null;
        $("#repo-path").value = "";
        state.pendingOnboardingRepositories = [];
        renderProductionBranchSelection();
        $("#clone-repository-status").textContent = "";
        $("#clone-repository-status").classList.remove("error");
        updateCloneButton();
    };
    $("#repo-clone-url").addEventListener("input", () => {
        if (!state.repositoryCloneBusy)
            clearCloneSelection();
        updateCloneButton();
    });
    $("#choose-clone-destination").addEventListener("click", async () => {
        if (state.repositoryCloneBusy || state.cloneDestinationChoosing)
            return;
        const button = $("#choose-clone-destination");
        state.cloneDestinationChoosing = true;
        button.disabled = true;
        $$('[data-onboarding-mode]').forEach((item) => { item.disabled = true; });
        updateCloneButton();
        $("#clone-destination-path").textContent = "Finder is open — choose a destination…";
        try {
            const result = await api("/api/system/select-folder", { method: "POST", body: { purpose: "clone-destination" } });
            if (result.cancelled) {
                $("#clone-destination-path").textContent = $("#clone-destination").value || "No destination selected";
                return;
            }
            $("#clone-destination").value = result.path || "";
            $("#clone-destination-path").textContent = result.path || "No destination selected";
            clearCloneSelection();
        }
        catch (error) {
            $("#clone-destination-path").textContent = "Could not open Finder";
            toast(error.message, "error");
        }
        finally {
            state.cloneDestinationChoosing = false;
            button.disabled = false;
            $$('[data-onboarding-mode]').forEach((item) => { item.disabled = false; });
            updateCloneButton();
        }
    });
    $("#clone-repository").addEventListener("click", async () => {
        if (state.repositoryCloneBusy || state.cloneDestinationChoosing)
            return;
        const button = $("#clone-repository");
        const status = $("#clone-repository-status");
        const remoteUrl = $("#repo-clone-url").value.trim();
        const destinationPath = $("#clone-destination").value;
        if (!remoteUrl || !destinationPath) {
            updateCloneButton();
            return;
        }
        const resumeId = state.repositoryCloneJobId;
        clearCloneSelection();
        state.repositoryCloneJobId = resumeId;
        state.repositoryCloneBusy = true;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = "Cloning…";
        $("#repo-clone-url").disabled = true;
        $("#choose-clone-destination").disabled = true;
        $$('[data-onboarding-mode]').forEach((item) => { item.disabled = true; });
        status.classList.remove("error");
        status.textContent = "Cloning with Git. Checking saved credentials; Git remote can retry with SSH if sign-in is needed…";
        try {
            const job = resumeId ? await repositoryCloneJobs.get(resumeId) : await repositoryCloneJobs.start({ remoteUrl, destinationPath });
            state.repositoryCloneJobId = job.id;
            const result = await repositoryCloneJobs.wait(job, current => {
                status.textContent = current.message || "Cloning in the background. You can close this panel and return later.";
            });
            state.repositoryCloneJobId = null;
            state.pendingOnboardingRepositories = [result.repository];
            $("#repo-path").value = JSON.stringify([result.repository.path]);
            status.textContent = result.fallbackUsed
                ? `Cloned ${result.repository.name} using SSH. HTTPS sign-in was unavailable; future Git operations will also use SSH. Confirm its production branch below.`
                : `Cloned ${result.repository.name}${result.transport === "ssh" ? " using SSH" : ""}. Confirm its production branch below.`;
            renderProductionBranchSelection();
        }
        catch (error) {
            if (error.terminal)
                state.repositoryCloneJobId = null;
            else if (error.jobId)
                state.repositoryCloneJobId = error.jobId;
            status.classList.add("error");
            status.textContent = error.message;
        }
        finally {
            state.repositoryCloneBusy = false;
            button.setAttribute("aria-busy", "false");
            button.textContent = "Clone repository";
            $("#repo-clone-url").disabled = false;
            $("#choose-clone-destination").disabled = false;
            $$('[data-onboarding-mode]').forEach((item) => { item.disabled = false; });
            updateCloneButton();
            renderProductionBranchSelection();
            void refreshCloneHistory();
        }
    });
    $("#clone-job-history").addEventListener("click", event => {
        const button = event.target.closest("[data-resume-clone]");
        if (!button || state.repositoryCloneBusy || state.cloneDestinationChoosing)
            return;
        const job = state.cloneJobHistory?.find(item => item.id === button.dataset.resumeClone);
        if (!job)
            return;
        document.querySelector('[data-onboarding-mode="clone"]').click();
        $("#repo-clone-url").value = job.remoteUrl;
        $("#clone-destination").value = job.destinationPath;
        $("#clone-destination-path").textContent = job.destinationPath;
        state.repositoryCloneJobId = job.id;
        updateCloneButton();
        $("#clone-repository").click();
    });
    $("#onboarding-prerequisites-refresh").addEventListener("click", refreshOnboardingPrerequisites);
    $("#repo-production-branches").addEventListener("change", (event) => {
        const include = event.target.closest("[data-onboarding-include]");
        if (include) {
            const repository = state.pendingOnboardingRepositories[Number(include.dataset.onboardingInclude)];
            if (repository)
                repository.excluded = !include.checked;
            renderProductionBranchSelection();
            return;
        }
        const select = event.target.closest("[data-production-branch-index]");
        if (!select)
            return;
        const repository = state.pendingOnboardingRepositories[Number(select.dataset.productionBranchIndex)];
        if (repository)
            repository.productionBranch = select.value;
        renderProductionBranchSelection();
    });
    $("#repo-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.repositoryCloneBusy || state.cloneDestinationChoosing || state.folderDiscoveryBusy || state.onboardingSubmitting)
            return;
        if (!$("#repo-path").value)
            return toast("Choose local repositories or clone one from Git first", "error");
        try {
            const repositories = selectedOnboardingRepositories();
            if (!repositories.length)
                return toast("Select at least one eligible repository to onboard", "error");
            if (repositories.some((repository) => !repository.productionBranch))
                return toast("Select a production branch for every repository", "error");
            state.onboardingSubmitting = true;
            renderProductionBranchSelection();
            const job = await api("/api/repository-onboarding/jobs", { method: "POST", body: { repositories } });
            state.backgroundJobs = [job, ...state.backgroundJobs.filter((item) => item.id !== job.id)];
            state.backgroundJobStatuses.set(job.id, job.status);
            state.dismissedBackgroundJobs.delete(job.id);
            renderBackgroundJobs();
            $("#repo-dialog").close();
            toast("Onboarding started — keep using Argus while it runs in the background");
        }
        catch (error) {
            toast(error.message, "error");
        }
        finally {
            state.onboardingSubmitting = false;
            renderProductionBranchSelection();
        }
    });
    $("#refresh-git").addEventListener("click", () => { void refreshActiveRepository(); void gitStashes.refresh(); });
    $("#branch-selector").addEventListener("click", () => openBranchSelector());
    $("#copy-branch-button").addEventListener("click", copyCurrentBranchName);
    $("#branch-dialog").addEventListener("close", () => { if (!$("#branch-dialog").open)
        branchPicker.close(); });
    $("#branch-search-input").addEventListener("input", (event) => renderBranchPicker(event.target.value));
    $$("[data-branch-mode]").forEach((button) => button.addEventListener("click", () => setBranchMode(button.dataset.branchMode)));
    $("#branch-form").elements.newBranch.addEventListener("input", updateBranchConfirmation);
    $("#create-branch-start").addEventListener("input", updateBranchConfirmation);
    $("#branch-picker-list").addEventListener("click", (event) => { const branch = event.target.closest("[data-branch-candidate]"); if (branch)
        selectBranchCandidate(branch.dataset.branchCandidate); });
    $("#branch-form").addEventListener("submit", switchBranch);
    $("#git-branches").addEventListener("click", (event) => { const branch = event.target.closest("[data-choose-branch]"); if (branch)
        openBranchSelector(branch.dataset.chooseBranch); });
    $("#fetch-button").addEventListener("click", () => gitAction("fetch"));
    $("#pull-button").addEventListener("click", () => gitAction("pull"));
    $("#push-button").addEventListener("click", () => gitAction("push"));
    $("#commit-button").addEventListener("click", () => gitAction("commit", { message: $("#commit-message").value }));
    $$("[data-git-view]").forEach((button) => button.addEventListener("click", () => {
        $$("[data-git-view]").forEach((item) => item.classList.toggle("active", item === button));
        $$(".git-view").forEach((view) => view.classList.add("hidden"));
        $(`#git-${button.dataset.gitView}`).classList.remove("hidden");
    }));
    $("#change-list").addEventListener("click", async (event) => {
        const row = event.target.closest(".change-row");
        if (!row)
            return;
        const selector = event.target.closest("[data-git-selection]");
        if (selector) {
            event.stopPropagation();
            if (state.gitActionRepositories.has(state.activeRepository?.id)) {
                selector.checked = state.selectedGitChanges.has(selector.dataset.gitSelection);
                return;
            }
            if (selector.checked)
                state.selectedGitChanges.add(selector.dataset.gitSelection);
            else
                state.selectedGitChanges.delete(selector.dataset.gitSelection);
            renderGitSelectionToolbar();
            return;
        }
        const fileAction = event.target.closest("[data-git-file-action]")?.dataset.gitFileAction;
        if (fileAction) {
            event.stopPropagation();
            await runGitFileAction(row.dataset.file, fileAction);
            return;
        }
        const action = event.target.closest("[data-git-action]")?.dataset.gitAction;
        if (action) {
            event.stopPropagation();
            await gitAction(action, { files: [row.dataset.file] });
        }
        else
            showDiff(row.dataset.file, row.dataset.staged === "true");
    });
    $("#clear-change-selection").addEventListener("click", () => {
        if (state.gitActionRepositories.has(state.activeRepository?.id))
            return;
        state.selectedGitChanges.clear();
        $$("[data-git-selection]").forEach((input) => { input.checked = false; });
        renderGitSelectionToolbar();
    });
    $("#stage-selected-files").addEventListener("click", () => runSelectedGitAction("stage"));
    $("#unstage-selected-files").addEventListener("click", () => runSelectedGitAction("unstage"));
    $("#revert-selected-files").addEventListener("click", runSelectedGitRevert);
    $("#run-agent").addEventListener("click", () => handleComposerAction("repository"));
    $("#queue-agent-prompt").addEventListener("click", () => queueCurrentPrompt("repository"));
    $("#new-repository-task").addEventListener("click", () => startTaskDraft("repository"));
    $("#repository-task-list").addEventListener("click", (event) => { const rename = event.target.closest("[data-rename-task]"); if (rename)
        return renameTask("repository", rename.dataset.renameTask); const remove = event.target.closest("[data-delete-task]"); if (remove)
        return deleteTask("repository", remove.dataset.deleteTask); const task = event.target.closest("[data-ai-task]"); if (task)
        void selectTask("repository", task.dataset.aiTask, { dismissTaskHistory: true }).catch(error => toast(error.message, "error")); });
    $("#agent-provider").addEventListener("change", () => handleProviderChange("repository"));
    $("#agent-context-mode").addEventListener("change", () => persistContextMode("repository"));
    $("#agent-model").addEventListener("change", () => handleModelChange("repository"));
    for (const panel of $$(".composer-model-menu > .composer-popover")) {
        panel.addEventListener("toggle", event => {
            if (event.newState === "open")
                void providerStatusPoller.poll({ force: true });
        });
    }
    for (const button of $$("[data-refresh-model-catalog]")) {
        button.addEventListener("click", () => void providerStatusPoller.poll({ force: true }));
    }
    $("#agent-effort").addEventListener("change", () => handleSpeedChange("repository"));
    $("#agent-speed").addEventListener("change", () => handleSpeedChange("repository"));
    $("#agent-mode").addEventListener("change", () => { updateLocalAIInfo(); renderModelConfigurationSummary("repository"); });
    $("#repo-agent-tabs").addEventListener("click", (event) => { const tab = event.target.closest("[data-agent-job]"); const job = state.repositoryJobs.find((item) => item.id === tab?.dataset.agentJob); if (job?.taskId)
        selectTask("repository", job.taskId);
    else if (job)
        showRepositoryJob(job); });
    $("#agent-prompt").addEventListener("keydown", (event) => handleComposerKeydown(event, "repository"));
    $("#agent-prompt").addEventListener("input", (event) => { storeComposerDraft("repository"); resizeAgentComposer(event.currentTarget); });
    $("#agent-prompt").addEventListener("paste", (event) => handleComposerPaste(event, "repository"));
    $$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#agent-prompt").value = button.dataset.prompt; storeComposerDraft("repository"); resizeAgentComposer($("#agent-prompt")); $("#agent-prompt").focus(); }));
    $("#nexus-shortcut").addEventListener("click", () => launchWorkspaceTool(openGlobalCodex));
    for (const scope of ["repository", "global"]) {
        const conversation = scope === "global" ? $("#global-agent-conversation") : $("#agent-conversation");
        checkpointNavigation.set(scope, createChatCheckpointNavigation({
            scroller: conversationScroller(scope), conversation,
            rail: $(`[data-chat-navigation="${scope}"]`), window,
        }));
        conversation.addEventListener("click", (event) => {
            const revisions = event.target.closest("[data-chat-revisions]");
            if (revisions)
                return chatRevisionViewer.open({ taskId: revisions.dataset.chatRevisions, scope, trigger: revisions })
                    .catch((error) => toast(error.message, "error"));
            const checkpoint = event.target.closest("[data-checkpoint-message]");
            if (checkpoint)
                return checkpointActions.toggle(scope, checkpoint.dataset.checkpointTask, checkpoint.dataset.checkpointMessage);
            const resume = event.target.closest("[data-resume-queue]");
            if (resume)
                return handleSavedQueueAction(scope, resume.dataset.resumeQueue);
            const discard = event.target.closest("[data-discard-queued]");
            if (discard)
                return handleSavedQueueAction(scope, discard.dataset.queueTask, discard.dataset.discardQueued);
            const queuedEdit = event.target.closest("[data-edit-queued]");
            if (queuedEdit)
                return openQueuedPromptEdit(scope, queuedEdit.dataset.queueTask, queuedEdit.dataset.editQueued, queuedEdit);
            const steer = event.target.closest("[data-steer-queued]");
            if (steer)
                return queuedPromptSteering.steer(scope, steer.dataset.queueTask, steer.dataset.steerQueued);
            const checkSteer = event.target.closest("[data-check-steer]");
            if (checkSteer)
                return queuedPromptSteering.reconcile(scope, checkSteer.dataset.queueTask, checkSteer.dataset.checkSteer);
            const button = event.target.closest("[data-edit-prompt]");
            if (!button)
                return;
            promptEditor.open({ scope, taskId: button.dataset.editTask, messageId: button.dataset.editPrompt, trigger: button })
                .catch((error) => toast(error.message, "error"));
        });
    }
    $("#daily-planner-toggle").addEventListener("click", () => launchWorkspaceTool(() => switchPrimaryView("daily-planner")));
    $("#run-global-agent").addEventListener("click", () => handleComposerAction("global"));
    $("#queue-global-agent-prompt").addEventListener("click", () => queueCurrentPrompt("global"));
    $("#switch-context-provider").addEventListener("click", () => {
        const request = state.unsupportedContextRequest;
        if (!request?.providerId)
            return;
        const control = request.scope === "global" ? $("#global-agent-provider") : $("#agent-provider");
        control.value = request.providerId;
        handleProviderChange(request.scope);
        $("#unsupported-context-dialog").close();
        toast(`Switched to ${selectedProvider(request.scope)?.name || "a compatible provider"}. Attach the context again.`);
    });
    $("#background-jobs-minimize").addEventListener("click", () => { state.backgroundJobsMinimized = true; renderBackgroundJobs(); });
    $("#background-jobs-pause").addEventListener("click", toggleAllBackgroundJobsPause);
    $("#background-jobs-reopen").addEventListener("click", (event) => { if (event.currentTarget.dataset.dragClick)
        return; state.backgroundJobsMinimized = false; renderBackgroundJobs(); });
    $("#background-jobs-close").addEventListener("click", closeBackgroundActivity);
    $("#background-jobs-history-toggle").addEventListener("click", () => { state.backgroundJobsExpanded = !state.backgroundJobsExpanded; renderBackgroundJobs(); });
    $("#background-jobs-list").addEventListener("click", (event) => {
        const pause = event.target.closest("[data-background-job-pause]");
        if (pause)
            return toggleBackgroundJobPause(pause.dataset.backgroundJobPause);
        const close = event.target.closest("[data-background-job-close]");
        if (close)
            return closeBackgroundJob(close.dataset.backgroundJobClose);
    });
    $("#background-jobs-list").addEventListener("toggle", (event) => {
        const logs = event.target.closest?.("[data-background-job-logs]");
        if (logs)
            state.backgroundJobLogExpanded.set(logs.dataset.backgroundJobLogs, logs.open);
    }, true);
    installBackgroundActivityDragging();
    $("#new-global-task").addEventListener("click", () => startTaskDraft("global"));
    $("#global-task-list").addEventListener("click", (event) => { const rename = event.target.closest("[data-rename-task]"); if (rename)
        return renameTask("global", rename.dataset.renameTask); const remove = event.target.closest("[data-delete-task]"); if (remove)
        return deleteTask("global", remove.dataset.deleteTask); const task = event.target.closest("[data-ai-task]"); if (task)
        selectTask("global", task.dataset.aiTask); });
    $("#global-agent-provider").addEventListener("change", () => handleProviderChange("global"));
    $("#global-agent-context-mode").addEventListener("change", () => persistContextMode("global"));
    $("#global-agent-model").addEventListener("change", () => handleModelChange("global"));
    $("#global-agent-effort").addEventListener("change", () => handleSpeedChange("global"));
    $("#global-agent-speed").addEventListener("change", () => handleSpeedChange("global"));
    $("#global-agent-mode").addEventListener("change", () => { updateGlobalAIInfo(); renderModelConfigurationSummary("global"); });
    $("#global-agent-prompt").addEventListener("keydown", (event) => handleComposerKeydown(event, "global"));
    $("#global-agent-prompt").addEventListener("input", (event) => { storeComposerDraft("global"); resizeAgentComposer(event.currentTarget); });
    $("#global-agent-prompt").addEventListener("paste", (event) => handleComposerPaste(event, "global"));
    $$('[data-attach-browser]').forEach((button) => button.addEventListener("click", () => attachLatestBrowserContext(button.dataset.attachBrowser)));
    $$('[data-attach-file]').forEach((button) => button.addEventListener("click", () => {
        const input = button.dataset.attachFile === "global" ? $("#global-file-input") : $("#repository-file-input");
        if (!providerSupportsContext(selectedProvider(button.dataset.attachFile), "file"))
            return showUnsupportedContext(button.dataset.attachFile, "file");
        input.click();
    }));
    $("#repository-file-input").addEventListener("change", async (event) => {
        try {
            await attachSelectedFiles(event.currentTarget.files, "repository");
        }
        catch (error) {
            toast(error.message, "error");
        }
        finally {
            event.currentTarget.value = "";
        }
    });
    $("#global-file-input").addEventListener("change", async (event) => {
        try {
            await attachSelectedFiles(event.currentTarget.files, "global");
        }
        catch (error) {
            toast(error.message, "error");
        }
        finally {
            event.currentTarget.value = "";
        }
    });
    $$(".context-tray").forEach((tray) => tray.addEventListener("click", (event) => {
        const remove = event.target.closest("[data-remove-context]");
        if (!remove)
            return;
        const attachments = scopedAttachments(remove.dataset.contextScope);
        const index = attachments.findIndex((item) => item.id === remove.dataset.removeContext);
        if (index < 0)
            return;
        attachments.splice(index, 1);
        renderContextTray(remove.dataset.contextScope);
    }));
    document.addEventListener("click", (event) => {
        $$(".model-settings-menu[open]").forEach((menu) => { if (!menu.contains(event.target))
            menu.removeAttribute("open"); });
    });
    $("#global-agent-tabs").addEventListener("click", (event) => { const tab = event.target.closest("[data-agent-job]"); const job = state.globalJobs.find((item) => item.id === tab?.dataset.agentJob); if (job?.taskId)
        selectTask("global", job.taskId);
    else if (job)
        showGlobalJob(job); });
    $("#api-client-toggle").addEventListener("click", () => launchWorkspaceTool(openApiClient));
    $("#refresh-api-client").addEventListener("click", () => openApiClient());
    $("#api-environment-select").addEventListener("change", (event) => selectApiEnvironment(event.currentTarget.value));
    $("#manage-api-environments").addEventListener("click", openApiEnvironmentDialog);
    $("#api-environment-form").addEventListener("submit", saveApiEnvironment);
    $("#api-environment-list").addEventListener("click", (event) => {
        const item = event.target.closest("[data-api-environment-id]");
        const environment = state.apiEnvironments.find((candidate) => candidate.id === item?.dataset.apiEnvironmentId);
        if (environment)
            editApiEnvironment(environment).catch((error) => toast(error.message, "error"));
    });
    $("#new-api-environment").addEventListener("click", () => editApiEnvironment());
    $("#import-api-environment").addEventListener("click", importApiEnvironment);
    $("#export-api-environment").addEventListener("click", exportApiEnvironment);
    $("#delete-api-environment").addEventListener("click", deleteApiEnvironment);
    $("#copy-api-curl").addEventListener("click", copyApiCurl);
    for (const view of ["saved", "history"]) {
        const tab = $(`#api-${view}-tab`);
        tab.addEventListener("click", () => selectApiSidebar(view));
        tab.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
                return;
            event.preventDefault();
            const target = event.key === "Home" ? "saved" : event.key === "End" ? "history" : view === "saved" ? "history" : "saved";
            selectApiSidebar(target);
            $(`#api-${target}-tab`).focus();
        });
    }
    $("#api-history-search").addEventListener("input", renderApiRequestHistory);
    $("#api-history-list").addEventListener("click", event => {
        const remove = event.target.closest("[data-delete-api-history]");
        if (remove)
            return deleteApiHistoryEntry(remove.dataset.deleteApiHistory);
        const entry = event.target.closest("[data-api-history-id]");
        if (entry)
            openApiHistoryEntry(entry.dataset.apiHistoryId);
    });
    $("#open-api-history").addEventListener("click", () => {
        selectApiSidebar("history");
        $("#api-client-drawer").classList.add("api-history-open");
        $("#open-api-history").setAttribute("aria-expanded", "true");
        $("#api-history-search").focus();
    });
    const closeApiHistoryOverlay = () => {
        $("#api-client-drawer").classList.remove("api-history-open");
        $("#open-api-history").setAttribute("aria-expanded", "false");
        $("#open-api-history").focus();
    };
    $("#close-api-history").addEventListener("click", closeApiHistoryOverlay);
    $("#api-request-sidebar").addEventListener("keydown", event => {
        if (event.key === "Escape" && $("#api-client-drawer").classList.contains("api-history-open")) {
            event.preventDefault();
            closeApiHistoryOverlay();
        }
    });
    $("#new-api-request").addEventListener("click", () => editApiRequest());
    $("#new-api-collection").addEventListener("click", openApiCollectionDialog);
    $("#api-collection-form").addEventListener("submit", createApiCollection);
    $("#import-api-file").addEventListener("click", importApiFile);
    $("#export-api-file").addEventListener("click", exportApiFile);
    $("#open-api-folder").addEventListener("click", openApiFolder);
    $("#import-curl").addEventListener("click", () => { $("#curl-form").reset(); renderApiCollectionOptions(); showAppDialog("curl-dialog"); });
    $("#curl-form").addEventListener("submit", importCurl);
    $("#api-request-list").addEventListener("click", (event) => {
        const deleteCollection = event.target.closest("[data-delete-api-collection]");
        if (deleteCollection)
            return deleteApiCollection(deleteCollection.dataset.deleteApiCollection);
        const deleteCollectionPath = event.target.closest("[data-delete-api-collection-path]");
        if (deleteCollectionPath)
            return deleteApiCollection("", deleteCollectionPath.dataset.deleteApiCollectionPath);
        const deleteRequest = event.target.closest("[data-delete-api-request]");
        if (deleteRequest)
            return deleteApiRequestById(deleteRequest.dataset.deleteApiRequest);
        const collection = event.target.closest("[data-api-collection-toggle]");
        if (collection)
            return toggleApiCollection(collection.dataset.apiCollectionToggle);
        const row = event.target.closest("[data-api-request-id]");
        const request = state.apiRequests.find((item) => item.id === row?.dataset.apiRequestId);
        if (request)
            editApiRequest(request);
    });
    $("#api-request-form").addEventListener("submit", sendApiRequest);
    for (const type of ["input", "change"])
        $("#api-request-form").addEventListener(type, () => {
            if (state.apiResponse && !captureApiRequestSnapshot().response)
                resetApiResponse();
        });
    $("#api-request-form").elements.url.addEventListener("focus", editApiUrlTemplate);
    $("#api-request-form").elements.url.addEventListener("blur", saveApiUrlTemplate);
    $("#api-request-form").elements.url.addEventListener("input", renderApiUrlHighlight);
    $("#api-request-form").elements.url.addEventListener("paste", importCurlFromUrlPaste);
    $("#api-request-form").elements.url.addEventListener("scroll", renderApiUrlHighlight);
    $("#save-api-request").addEventListener("click", saveApiRequest);
    $("#delete-api-request").addEventListener("click", () => deleteApiRequestById(state.activeApiRequest?.id));
    $$("[data-api-editor]").forEach((button) => button.addEventListener("click", () => {
        $$("[data-api-editor]").forEach((item) => item.classList.toggle("active", item === button));
        for (const kind of ["query", "headers", "body"])
            $(`#api-${kind}-editor`).classList.toggle("hidden", button.dataset.apiEditor !== kind);
    }));
    $$("[data-api-parameter-view]").forEach((button) => button.addEventListener("click", () => {
        const [kind, view] = button.dataset.apiParameterView.split(":");
        setApiParameterView(kind, view);
    }));
    $$("[data-add-api-parameter]").forEach((button) => button.addEventListener("click", () => addApiParameterRow(button.dataset.addApiParameter)));
    for (const kind of ["query", "headers"]) {
        const container = apiParameterContainer(kind);
        const synchronize = () => {
            if (kind === "query")
                syncApiUrlFromParameters();
            else
                updateApiParameterCounts();
        };
        container.addEventListener("input", (event) => {
            if (event.target.matches("[data-api-parameter-value]"))
                event.target.classList.toggle("contains-api-variable", /\{\{\s*[^{}]+?\s*\}\}/.test(event.target.value));
            synchronize();
        });
        container.addEventListener("change", synchronize);
        container.addEventListener("click", (event) => {
            const remove = event.target.closest("[data-remove-api-parameter]");
            if (!remove)
                return;
            remove.closest(".api-parameter-row")?.remove();
            if (!container.querySelector(".api-parameter-row"))
                renderApiParameterRows(kind, []);
            synchronize();
        });
        apiParameterJsonInput(kind).addEventListener("input", () => {
            try {
                updateApiParameterCount(kind, apiParametersFromJson(kind));
            }
            catch { }
            if (kind === "query")
                syncApiUrlFromParameters();
        });
    }
    $$("[data-beautify]").forEach((button) => button.addEventListener("click", () => beautifyRequestPart(button.dataset.beautify)));
    $$("[data-api-response]").forEach((button) => button.addEventListener("click", () => {
        $$("[data-api-response]").forEach((item) => item.classList.toggle("active", item === button));
        $("#api-response-body").classList.toggle("hidden", button.dataset.apiResponse !== "body");
        $("#api-response-headers").classList.toggle("hidden", button.dataset.apiResponse !== "headers");
    }));
    $("#beautify-api-response").addEventListener("click", () => {
        const response = $("#api-response-body");
        if (!renderResponseContent(response, response.dataset.raw || response.textContent)) {
            toast("Response body is not valid JSON", "error");
        }
    });
    $("#toggle-response-wrap").addEventListener("click", (event) => {
        const wrapping = event.currentTarget.classList.toggle("active");
        $$(".api-response-panel pre").forEach((response) => response.classList.toggle("no-wrap", !wrapping));
        event.currentTarget.textContent = wrapping ? "Wrap lines" : "No wrap";
    });
    $("#copy-api-response").addEventListener("click", async () => {
        const response = $(".api-response-panel pre:not(.hidden)");
        try {
            await navigator.clipboard.writeText(response.dataset.raw || response.textContent);
            toast("Response copied");
        }
        catch {
            toast("Could not copy the response", "error");
        }
    });
    $$(".api-response-panel pre").forEach((response) => {
        response.addEventListener("pointerdown", () => response.focus());
        response.addEventListener("keydown", selectOnlyResponseContent);
    });
    bindApiResizers();
    bindWorkspaceResizer();
    $("#services-toggle").addEventListener("click", () => launchWorkspaceTool(() => switchPrimaryView("services")));
    $("#refresh-services").addEventListener("click", () => refreshProcesses(true));
    $("#stop-all-services").addEventListener("click", stopAllServices);
    $("#service-form").addEventListener("submit", saveService);
    $("#service-form").elements.launchMode.addEventListener("change", renderServiceLaunchMode);
    $("#service-dialog").addEventListener("close", () => { state.serviceConfigurationRevision = (state.serviceConfigurationRevision || 0) + 1; });
    $$("[data-environment-format]").forEach((button) => button.addEventListener("click", () => setEnvironmentFormat(button.dataset.environmentFormat)));
    $("#service-list").addEventListener("click", async (event) => {
        const debug = event.target.closest("[data-service-debug]");
        if (debug)
            return startServiceDebug(debug);
        const debuggerButton = event.target.closest("[data-service-debugger]");
        if (debuggerButton) {
            await activateRepository(debuggerButton.dataset.serviceDebugger);
            if (state.currentView !== "repository" || state.activeRepository?.id !== debuggerButton.dataset.serviceDebugger)
                return;
            await repositoryIdeBridge.enable(debuggerButton.dataset.serviceDebugger);
            if (state.currentView !== "repository" || state.activeRepository?.id !== debuggerButton.dataset.serviceDebugger)
                return;
            await repositoryIdeBridge.refreshDebug();
            return;
        }
        const maintenance = event.target.closest("[data-service-maintenance]");
        if (maintenance)
            return runServiceMaintenance(maintenance);
        const detectedRuntime = event.target.closest("[data-start-detected-runtime]");
        if (detectedRuntime)
            return startDetectedRuntime(detectedRuntime.dataset.startDetectedRuntime);
        const configure = event.target.closest("[data-configure-service]");
        if (configure)
            return openServiceConfiguration(configure.dataset.configureService, configure.dataset.serviceRepository);
        const codex = event.target.closest("[data-service-codex]");
        if (codex) {
            await activateRepository(codex.dataset.serviceCodex);
            $("#services-drawer").classList.add("hidden");
            $("#agent-prompt").focus();
            return;
        }
        const action = event.target.closest("[data-service-action]");
        if (action)
            return serviceAction(action.dataset.configId, action.dataset.serviceAction);
        const logs = event.target.closest("[data-show-logs]");
        if (logs)
            return showLogs(logs.dataset.showLogs, logs.dataset.serviceName, logs.dataset.logConfigId);
        const remove = event.target.closest("[data-delete-config]");
        if (remove && !serviceOperations.has(remove.dataset.deleteConfig) && confirm("Delete this run configuration?")) {
            await withServiceOperation(remove.dataset.deleteConfig, "delete", async () => {
                await api(`/api/run-configurations/${remove.dataset.deleteConfig}`, { method: "DELETE" });
                state.workspace = await loadWorkspaceSnapshot();
                renderServices();
            });
        }
    });
    $("#close-logs").addEventListener("click", closeServiceLogs);
    $("#copy-service-logs").addEventListener("click", copyAllServiceLogs);
    $("#toggle-log-wrap").addEventListener("click", (event) => {
        state.logWrap = !state.logWrap;
        $("#log-output").classList.toggle("wrap", state.logWrap);
        event.currentTarget.classList.toggle("active", state.logWrap);
        event.currentTarget.textContent = state.logWrap ? "No wrap" : "Wrap";
    });
}
const fontFamilyPicker = initializeFontFamilyPicker({
    document,
    storage: localStorage,
    save: (fontFamily) => api("/api/preferences", { method: "PATCH", body: { fontFamily } }),
});
const nexusThemePicker = initializeNexusThemePicker({
    document,
    storage: localStorage,
    save: (nexusTheme, nexusThemes) => api("/api/preferences", { method: "PATCH", body: { nexusTheme, nexusThemes } }),
    onSelect(nexusTheme, nexusThemes) {
        if (state.workspace)
            state.workspace.preferences = { ...(state.workspace.preferences || {}), nexusTheme, nexusThemes };
    },
    setAppearance: (theme) => applyTheme(theme),
});
const jsonExplorer = createJsonExplorer($("#json-explorer-panel"), { notify: toast });
state.repositoryTabDrag = setupRepositoryTabDrag({
    rail: $("#repo-tabs"),
    canDrag: () => Boolean(state.workspace) && !state.repositoryTabSaving,
    onMove: moveRepositoryTab,
    onSettled: () => {
        if (state.repositoryTabRenderPending) {
            state.repositoryTabRenderPending = false;
            renderRepositoryTabs();
        }
    },
});
repositoryTabSearch = createRepositoryTabSearch({
    document,
    getRepositories: () => state.workspace ? repositoryTabLayout(state.workspace.repositories, repositoryTabGroups(), state.workspace.preferences?.repositoryTabOrder)
        .flatMap(item => item.type === "repository" ? [item.repository] : item.repositories) : [],
    getGroups: () => state.workspace ? repositoryTabGroups() : [],
    getActiveRepositoryId: () => state.currentView === "repository" ? state.activeRepository?.id : null,
    onSelect: async (repositoryId) => {
        await activateRepository(repositoryId);
        return isRepositoryDestination(repositoryId);
    },
    onError: error => toast(error.message, "error"),
});
const gitStashes = initializeGitStashes({
    document,
    getRepository: () => state.activeRepository,
    request: api,
    showDialog: (id) => { if (!closeOpenDialogs(id))
        return false; $(`#${id}`).showModal(); return true; },
    mutate: createGitStashActions({
        getRepository: () => state.activeRepository,
        busyRepositories: state.gitActionRepositories,
        request: api,
        invalidate: () => { state.gitStatusVersion += 1; },
        refresh: () => refreshActiveRepository(),
    }),
});
initializeMermaidRendering();
let repositoryIdePreviousTasksCollapsed = null;
let repositoryTaskDrawer;
ideRunControls = createIdeRunControls({
    api, operations: serviceOperations,
    onChange: () => {
        if (serviceOperations.size)
            serviceProcessRevision++;
        repositoryIdeBridge.syncRunState();
        syncServicePendingControls();
        syncRepositoryPorts();
    },
    onProcesses: processes => acceptServiceProcesses(processes),
    beforeStart: ({ repository }) => {
        if (!repositoryIdeBridge.isVisible(repository.id))
            return false;
        if (repositoryIdeBridge.isDirty(repository.id))
            throw new Error("Save this repository’s unsaved files before running, debugging or syncing. Services use the files on disk.");
        return true;
    },
    onStarted: async (process, { repository, mode }) => {
        if (mode === "sync")
            projectSyncLifecycle.track(process);
        if (!repositoryIdeBridge.isVisible(repository.id))
            return;
        try {
            await repositoryIdeBridge.showRunLogs(repository.id);
        }
        catch (error) {
            toast(`Process output could not open: ${error.message}`, "error");
        }
        if (mode === "sync") {
            toast("Dependency sync started. Logs show progress; code navigation reloads its index after a successful sync.");
        }
        else if (mode === "debug") {
            try {
                await repositoryIdeBridge.attachLaunchedDebug(repository.id, process);
            }
            catch (error) {
                toast(error.message, "error");
            }
        }
        else
            toast("Service started. Its status and logs are also available in Services.");
    },
    onError: error => toast(error.message, "error"),
});
const repositoryIdeBridge = createRepositoryIdeBridge({
    document, storage: localStorage, api,
    getRepository: () => state.activeRepository,
    getCodeChatSettings: repositoryId => state.activeRepository?.id === repositoryId
        ? { provider: $("#agent-provider").value, ...selectedModelSettings("repository") } : {},
    onCodeChatOpenTask: async ({ repositoryId, taskId }) => {
        if (!repositoryIdeBridge.isVisible(repositoryId) || !taskId)
            return;
        repositoryIdeBridge.setChatVisible(true);
        await selectTask("repository", taskId, { isCurrent: () => state.activeRepository?.id === repositoryId && state.currentView === "repository" });
    },
    onCodeDiscussionChanged: async ({ repositoryId, taskId }) => {
        try {
            const tasks = await api(`/api/ai-tasks?scope=repository&repositoryId=${encodeURIComponent(repositoryId)}`, { dedupe: false });
            state.repositoryTasks[repositoryId] = tasks;
            if (state.activeRepository?.id !== repositoryId || state.currentView !== "repository")
                return;
            renderTaskList("repository");
            if (activeTaskId("repository") === taskId)
                await selectTask("repository", taskId, { background: true,
                    isCurrent: () => state.activeRepository?.id === repositoryId && activeTaskId("repository") === taskId });
        }
        catch (error) {
            if (state.activeRepository?.id === repositoryId)
                toast(`Code discussion saved; chat list refresh failed: ${error.message}`, "error");
        }
    },
    getRunState: () => ideRunControls.state,
    onRunAction: (mode, repositoryId) => repositoryIdeBridge.isVisible(repositoryId) ? ideRunControls.run(mode) : null,
    onRunSelect: (configurationId, repositoryId) => repositoryIdeBridge.isVisible(repositoryId) && ideRunControls.select(configurationId),
    onRunConfigure: repositoryId => repositoryIdeBridge.isVisible(repositoryId) && openServiceConfiguration(ideRunControls.state.selectedId, repositoryId),
    onTerminalMount: mountIdeTerminal,
    onTerminalToggle: toggleIdeTerminal,
    onTerminalHide: () => repositoryTerminal?.minimize({ restoreFocus: false }),
    getVersionControlOpen: repositoryId => state.activeRepository?.id === repositoryId
        && versionControlAvailable() && document.body.classList.contains("version-control-dock-open"),
    onVersionControlToggle: repositoryId => {
        if (state.activeRepository?.id === repositoryId && versionControlAvailable()) {
            setVersionControlDockOpen(!document.body.classList.contains("version-control-dock-open"));
        }
    },
    onVersionControlMount: slot => slot.append($("#repository-version-control-panel")),
    onError: (error) => toast(error.message, "error"),
    onFileSaved: ({ repositoryId }) => {
        state.gitStatusVersion++;
        if (state.activeRepository?.id === repositoryId) {
            void refreshActiveRepository();
            void repositoryPorts?.refresh();
        }
        if (state.currentView === "services")
            void refreshRuntimeDetections(true);
    },
    onNavigationChange: (_location, options) => queueAppNavigation(options),
    onChatVisibilityChange: () => repositoryTaskDrawer?.dismiss(),
    onVisibilityChange: (visible) => {
        if (visible) {
            syncIdeRunControls();
            void refreshProcesses(false);
            repositoryIdePreviousTasksCollapsed = $(".ai-canvas")?.classList.contains("task-panel-collapsed") ?? true;
            setTaskPanelCollapsed("repository", true, false);
            setVersionControlDockOpen(false, false);
        }
        else {
            setVersionControlDockOpen(false, false);
            repositoryTerminal?.minimize({ restoreFocus: false });
            ideRunControls.setContext({ repository: null });
            if (repositoryIdePreviousTasksCollapsed !== null) {
                $(".ai-canvas")?.classList.toggle("task-panel-collapsed", repositoryIdePreviousTasksCollapsed);
                repositoryIdePreviousTasksCollapsed = null;
                syncWorkspaceRail();
            }
        }
        queueAppNavigation();
    },
});
dailyPlanner = createDailyPlanner({ root: $("#daily-planner-panel"), api, toast, desktop: window.argusDesktop });
window.argusDesktop?.onPlannerOpen?.(() => {
    if (!state.navigationReady) {
        pendingPlannerOpen = true;
        return;
    }
    launchWorkspaceTool(() => switchPrimaryView("daily-planner"));
});
initializeDockedPanels();
initializeCompactComposers({ document });
installChatHistoryPanels({ document, toggle: (scope, open) => setTaskPanelCollapsed(scope, !open, false) });
repositoryTaskDrawer = createRepositoryTaskDrawer({
    document,
    getEnabled: () => state.currentView === "repository"
        && document.body.classList.contains("repository-ide-enabled")
        && !document.body.classList.contains("workspace-tool-active")
        && $("#repository-task-sidebar").matches(":popover-open"),
    onClose: () => setTaskPanelCollapsed("repository", true, false),
});
repositoryPorts = createRepositoryPorts({
    host: $("#repository-ports"), document, api: repositoryPortsApi,
    beforeOpen: closeOpenDialogs,
    canEditFile: canEditRepositoryPortFile,
    onSelect: selectRepositoryPortConfiguration,
    onConfigure: openServiceConfiguration,
    onInspected: repositoryPortsInspected,
    onSaved: repositoryPortSaved,
    onError: error => toast(error.message, "error"),
});
syncRepositoryPorts();
initializeSourceReferences({
    loadReference: (target, repositoryId) => api(`/api/source-reference?${new URLSearchParams({ target, ...(repositoryId ? { repositoryId } : {}) })}`),
    revealReference: (target, repositoryId) => api("/api/source-reference/reveal", { method: "POST", body: { target, ...(repositoryId ? { repositoryId } : {}) }, dedupe: false }),
  preferredRepositoryId: (button) => button.closest("#agent-conversation, #agent-output, .ide-code-chat") ? state.activeRepository?.id : null,
  getEditorTarget: button => {
    if (state.currentView !== "repository" || !button.closest("#agent-conversation, #agent-output, .ide-code-chat")) return null;
    const repositoryId = state.activeRepository?.id;
    if (!repositoryId) return null;
    return {
      repositoryId,
      isCurrent: () => state.currentView === "repository" && state.activeRepository?.id === repositoryId,
      open: (file, isCurrent) => repositoryIdeBridge.openSourceReference(repositoryId, file, isCurrent),
    };
  },
    showDialog: showAppDialog,
    onClose: closeFindBar,
});
initializeAttachmentViewer({
    loadPreview: (id, { signal }) => api(`/api/context/${encodeURIComponent(id)}/preview`, { signal, cache: "no-store", dedupe: false }),
    showDialog: showAppDialog,
    onClose: closeFindBar,
});
createRepositoryAiKit({ document, api, getRepository: () => state.currentView === "repository" ? state.activeRepository : null, onError: error => toast(error.message, "error") });
$("#data-storage-dialog").addEventListener("close", () => { storageLoadController?.abort(); });
serviceCardOrder = createServiceCardOrder({
    list: $("#service-list"), scrollContainer: $("#services-drawer"),
    save: async (order) => {
        await api("/api/preferences", { method: "PATCH", body: { serviceCardOrder: order } });
        if (state.workspace)
            state.workspace.preferences = { ...state.workspace.preferences, serviceCardOrder: serviceCardOrder.snapshot() };
    },
    onChange: order => {
        if (state.workspace)
            state.workspace.preferences = { ...state.workspace.preferences, serviceCardOrder: order };
        renderServices();
    },
    onSettled: () => renderServices(),
    onError: error => toast(`Service order could not be saved: ${error.message}. Move a card again to retry.`, "error"),
    announce: message => { $("#service-order-status").textContent = message; },
});
const providerStatusPoller = createProviderStatusPoller({
    visible: () => !document.hidden && state.navigationReady && !state.aiConnectionsRefreshPromise && !state.refreshingAiProviders.size,
    read: ({ force }) => api(`/api/agents/providers${force ? "?refresh=true" : ""}`, { timeout: 25000, cache: "no-store" }),
    onBusy: busy => {
        for (const button of $$("[data-refresh-model-catalog]")) {
            button.disabled = busy;
            button.setAttribute("aria-busy", String(busy));
            button.title = busy ? "Checking the connected CLI model catalogues…" : "Refresh models from connected CLIs";
        }
    },
    apply: providers => {
        const changed = providerSnapshotKey(state.providers) !== providerSnapshotKey(providers);
        state.providers = providers;
        if (changed)
            renderProviderOptions();
        else if ($("#ai-connections-dialog")?.open)
            renderAIConnections();
    },
});
runtimeStateSync = createRuntimeStateSync({
    enabled: () => !document.hidden && Boolean(state.workspace) && !state.serviceConfigurationSaving,
    read: () => api("/api/runtime-state", { cache: "no-store", dedupe: false, timeout: 5000 }),
    apply: snapshot => {
        if (!state.workspace)
            return;
        const changed = JSON.stringify([state.workspace.repositories, state.workspace.runConfigurations])
            !== JSON.stringify([snapshot.repositories, snapshot.runConfigurations]);
        if (!changed)
            return;
        state.workspace = { ...state.workspace, repositories: snapshot.repositories, runConfigurations: snapshot.runConfigurations };
        const active = snapshot.repositories.find(repository => repository.id === state.activeRepository?.id);
        if (active)
            state.activeRepository = active;
        else if (state.activeRepository) {
            storeComposerDraft("repository");
            state.activeRepository = null;
            syncRepositoryWorkspacePresence();
            void repositoryIdeBridge.sync(false, { focus: false });
            toast("This repository was disconnected. Unsaved editor buffers remain in this window; reconnect it to continue editing.");
        }
        renderRepositoryTabs();
        renderServices();
        if (state.currentView === "services")
            void refreshRuntimeDetections(true);
    },
});
bindEvents();
bindFindBar();
bindTerminalResizer();
initialize();
refreshBackupAccess();
refreshBackgroundJobs();
setInterval(pollServiceProcesses, 1000);
setInterval(() => void runtimeStateSync.refresh(), 5000);
setInterval(refreshBackgroundJobs, 1500);
setInterval(refreshVisibleGitStatus, 10000);
setInterval(() => void providerStatusPoller.poll(), 60000);
window.addEventListener("focus", () => void providerStatusPoller.poll());
window.addEventListener("focus", refreshVisibleGitStatus);
window.addEventListener("focus", pollServiceProcesses);
window.addEventListener("focus", () => void runtimeStateSync.refresh());
window.addEventListener("focus", () => void repositoryPorts?.refresh());
document.addEventListener("visibilitychange", () => {
    if (!document.hidden)
        void runtimeStateSync.refresh();
    if (!document.hidden)
        void providerStatusPoller.poll();
    if (!document.hidden)
        void refreshVisibleGitStatus();
    if (!document.hidden && !state.backupAccessPending)
        refreshBackupAccess();
    void pollServiceProcesses();
});
