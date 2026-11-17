# Work lifecycle and time budgets

Work phase: the request changes files, config, git or external state. Before its first change, INIT the entire requested plan with a goal, explanation and estimate for EVERY requested item; NEVER omit work or remember leftovers. Update the goal, steps, explanations, estimates and statuses with material scope changes.

Non-work phase: discussion, investigation, explanation, answering questions; nothing changes. NEVER create or extend a todo for it. Investigation that ends in a decided change enters the work phase at that change.

After each logical task operation, no active means earliest pending starts in phase order; only the earliest active remains; blocked never starts automatically. Completion can return the pointer to earlier open work without reopening completed items.

BLOCK external waits (user, agent, service) with an optional reason to suppress stop reminders; UNBLOCK returns pending. Append a clearing task for an agent-actionable blocker.

Only in_progress time counts; pending/blocked/closed pause it. Repeated START, VIEW and EXPLAIN do not reset elapsed time. No item may be estimated above the per-item limit (the leafMaxMinutes setting, 60 minutes by default): plan longer work as several items. Before an item's overtime warning, ESTIMATE preserves elapsed time and gives a changed budget one new overtime warning. Never re-init, remove and recreate items, or inflate estimates to hide overruns.

An overtime warning is a serious problem: the plan or the approach is wrong. Before any other step, check the evidence for why the item overran, decide whether the approach must change (consult a subagent, or your parent, when the cause is unclear), and state the cause and the next approach in your next message. The warned item's estimate is closed and ESTIMATE on it is rejected; more time only comes as new items for the remaining work, added with PHASE and ADD. Never reduce scope, acceptance criteria or quality because of a budget.

NEVER call todo alone: initialize with first work and update with the next action.

Read xd://todo/protocol for the document grammar, selectors, validation and completion commits.
