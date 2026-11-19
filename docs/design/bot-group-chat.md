# Bot group chat

**Design proposal.** A user can open a shared conversation with several of their Bots, address one or several of them, and come back to the same conversation for answers. Direct chat with Varin remains the simplest way to hand over work. A group is useful when the user wants the participants to hear each other, work out a decision together, or address the person doing the work directly.

The user can coordinate a group personally or ask any member to coordinate a particular release, project, or the group over time. Coordination is work a Bot accepts through ordinary conversation. Group creation only asks for a name and members. It requires no lead, speaking order, extra Bot profile, or shared model.

## A release conversation

1. The user creates **Release** with Varin and Ops. They write “@Varin, look after unaddressed messages here.” Varin enables that setting for itself in Release. The member list reflects the change.
2. The user writes “Let's ship Windows first.” Varin receives the instruction. Ops can find it in the group history later. Meanwhile the user can keep talking to Varin about something else in direct chat.
3. Varin writes “@Ops, take care of the image for this release.” The group sees the handoff once. Ops receives the request and can do it directly or dispatch a task. Its group reply can link to that task.
4. Ops replies “The image is ready. Could you make the package public?” The user taps **Reply** on that bubble and writes “Done.” The response goes to Ops, even though Varin listens to unaddressed messages. Ops can finish and post the result here. The user never has to open the task to continue the conversation.

## What goes into a Bot's context

Every accepted post has a place in the shared history. Admission to a member's conversation is a separate decision, made from the sender, explicit recipients and reply target at the time of posting.

| What was posted | Who receives input |
| --- | --- |
| User mentions one or more members | Each named member, once. A quoted message can supply context from a different author. |
| User uses **Reply** on a Bot's message, with no member mention | The author of that message. |
| User posts without a Bot addressee | Each member that opted into unaddressed user messages in this group. With zero listeners the message is still saved and searchable. |
| Bot explicitly addresses another member or hands it work in the group | The chosen recipients. A work request activates its recipient at the normal execution boundary. An explicitly informational handoff retains passive delivery. |
| Bot posts an answer, result, or progress update for the group | The post is available to members. An ordinary answer may quote the message it answers without requesting another turn from its author. |

The member setting is **Receive unaddressed user messages** (接收未指定对象的用户消息). It starts off for each new membership. The user can change it in member details and a Bot can change its own membership setting, including from a direct conversation about that group. Several members can opt in. Receiving a message allows a Bot to act, reply, or stay silent. Changes apply to future posts. The member list shows who has opted in, including changes made by a Bot.

In the composer, an addressed member is visible before sending. Use the existing mention picker with a group-member result that carries the selected Bot's identity, alongside file and task references. A name in pasted code, a quoted mention, and a file reference are content. An explicit member mention takes precedence over the quoted author. If an addressed member has left, show that at send time and let the user update the address. With no listeners and an empty draft, the placeholder can say “@ 成员可让它接话”. Posting a note still works.

Members can read earlier group messages on demand, including messages from before they joined. Offer recent messages, search, a specific post, and the conversation around a reply. Return the author, time, text, and useful attachment or task references. Preserve the distinction between a user's instruction and another Bot's words, including inside quotes. For a delivered message, supply the group, speaker, body and a short excerpt of the post being answered. The recipient can fetch more if “done” or “that image” needs explanation. A post with no delivery to this Bot triggers no model input, memory ingestion or wakeup for it. Ordinary room traffic therefore leaves its cached prompt prefix alone.

## Inside the group

Offer **New group chat** from the Bot sidebar's existing creation menu. Give each group one entry alongside direct chats, identified by a small cluster of member avatars and the group name. Opening it shows its timeline. The header shows its name and a member button. The same member view handles adding or removing Bots and the listener setting. On a narrow screen it can open as a sheet.

Use a messaging layout for the group. The user's messages sit on the right. Bots speak on the left with their actual avatars and names. Consecutive posts by the same speaker can share an avatar and name. A change of speaker or a reply to someone else should be easy to spot. Reply quotes show an author and an excerpt and jump to the original. Theme-aware bubble surfaces, spacing and alignment carry the distinction in both light and dark themes.

Reuse the existing Markdown, code, attachment and interactive-content renderers inside the bubbles. A code block or long report can use most of the available width. Folding a long response preserves its real opening and offers expansion in place. Work shared in the group shows the responsible Bot and opens the underlying task from the relevant message. Questions can be answered in the group. A permission decision uses its existing approval control bound to the actual operation.

Concurrent speakers get separate streaming bubbles, each attributed and updated in place. A silent turn produces no empty bubble. Keep message order and reply links stable through reconnects. Surface delivery trouble on the affected message or recipient, so a user can tell which Bot needs attention when the others have already answered.

## How this fits Varin

Today a Bot can own several native sessions, each with its own Thread and branch. Directed messages already carry an actor, attachments, a recipient and activation semantics. Child reports can find the original requester across continuations. The collaboration panel reads a projection of these events for a task family. None of these records can represent a user posting a note to a room with zero recipients. [Bot sessions](../../packages/web/application-host/lib/bots/bot-sessions.ts) · [Directed messages](../../kernel/crates/varin-runtime/src/catalog_messages.rs) · [Report routing](../../kernel/crates/varin-runtime/src/catalog_bot_reports.rs) · [Collaboration feed](../../kernel/crates/varin-runtime/src/catalog_message_feed.rs)

| Responsibility | Proposed implementation |
| --- | --- |
| Group, membership and public history | The Rust Catalog owns the group, its membership settings, and ordered posts. A post carries its author, content or published content reference, explicit recipients, optional reply target and shared work references. An empty recipient set is valid. The Application Host exposes this through the existing service connection to desktop, web and mobile. |
| A Bot working in a group | Lazily bind one native Bot Thread/branch to each group membership on its first delivery. This gives the Bot continuity in that room without appending group input to its direct chat or another room. Expose the room once in navigation. The execution binding is internal. The Bot retains its own model, memory, tools and lifecycle. |
| Delivery and recovery | At post commit, resolve the recipient set from current membership and record it with the post. Extend Catalog ingress to admit a reference to that post for each recipient through the existing execution queue. Use the post identity and recipient for idempotency across retries. Newly admitted work follows the normal active/idle boundary. A restart resumes outstanding deliveries without recomputing listeners or resending to successful recipients. |
| Replies and task reports | Carry the originating group and post alongside the receiving input. Publish the Bot's public response back to that group against the originating post, including after a queued turn or reconnect. A group's directed handoff has one public post and the corresponding targeted delivery. Private cross-session sends stay private. A dispatched task reports to its actual requester, which can share its result in the group. An explicitly shared task link reads status from its execution owner. |

Group history needs a first-class read target in the conversation tools, with group-relative post references for lookup and replies. Give participating Bots a way to post to the group, address members, and inspect or change their own listening preference. Tool results should use the group and member names and short usable references. Raw delivery receipts and internal identifiers belong in diagnostics. Reading history is side-effect free. Looking up an older post neither consumes an input nor starts other members.

The service resolves user and Bot identity from the existing authenticated request or executing session. Group membership governs room reads and publication, including through general conversation search. Referenced private conversations, tasks, devices and files still resolve through their individual owners. Share an actual attachment using the existing content and retention path when its contents are meant for the group. [File handoff](../collaboration.md#file-handoff-attachments)

The timeline can accept a post even when a selected Bot is asleep. Show which delivery could not start and allow the user to wake the Bot and retry that recipient. Removing a member ends its ability to read or publish to that group and drops its undelivered group inputs. Already started work keeps its actual execution and cancellation state. Prior messages retain their authorship and quotes.

## Acceptance examples

- In a room with three Bots and no listeners, a user posts a file and a note. Both survive reconnect. The Bots have no new input or Run. Later, an addressed member can find that note and open the shared attachment.
- Two members listen. Both receive an unaddressed user message. A reply to Ops reaches Ops alone. Quoting Ops while explicitly mentioning Varin reaches Varin with the quote. A Bot's public answer triggers no listener turn.
- Ops starts listening in Release at the user's request. Its setting in a second room stays off. The user turns listening off from another device. The next ordinary post in Release stays in the timeline and reaches only the remaining listeners.
- Two Bots reply concurrently while the user changes devices. Each reply stays attached to the correct author and original post. Retrying a failed delivery to one Bot preserves the other's completed response.
- A group task completes while the user is in a direct chat about something else. The requester can report the result in the original group. Its private tool trace stays in the task, and the user can continue from the result bubble.
