/** Metadata is derived from the retained message's actual sender by the Host. */
export interface ThreadMessageDelivery {
  from: string;
  requestId?: string;
  messageId?: string;
  replyTo?: string;
}

export function formatThreadMessage(text: string, meta: ThreadMessageDelivery): string {
  const id = meta.messageId ?? meta.requestId;
  const header = `Message from ${meta.from}${id ? ` (message ${id})` : ""}${meta.replyTo ? `, replying to ${meta.replyTo}` : ""}`;
  const instruction = meta.requestId
    ? `\nThis message requests a response or action. Answer its sender with send({replyTo: ${JSON.stringify(id)}, message: "your response"}). Writing an answer only in your own conversation does not send it back.`
    : id ? `\nIf a reply is useful, use send({replyTo: ${JSON.stringify(id)}, message: "your response"}). No acknowledgement is required.` : "";
  return `${header}:\n${text}${instruction}`;
}
