# Research tools

Ordinary selected SDK services backed by the existing research owner. Build with the normal extension CLI, install, grant `research.experiments`, and explicitly select the desired services in the tool directory. This example is never enabled or selected automatically.

`research_submit` and `research_wait` declare Thread Job completion. Submit accepts a durable attempt and returns its original body before independent preparation/execution. Wait uses the original Catalog observation and does not call the old blocking experiment wait API. Other services separately declare read or effect operations.

The trusted Host resolves source and family permissions from the original ModelStep or PolicyAction invocation. Tool arguments cannot select a workspace, claim a User actor, report executor stop, or invent a Job binding. Run cancellation and extension retirement do not stop accepted experiments; explicit attempt or task-tree stop follows the original domain owner. Artifacts and logs remain paged through that owner.
