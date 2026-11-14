import { useParams } from "react-router-dom";
import { ConsolePage } from "./console-page";

/**
 * `/chats/saved/:savedId`: a retained mission opens in the same live Conversation as `/chats/:id`.
 * It is read from its transcript (no engine starts); the first send resumes it. If a live session already owns
 * the record, that session opens instead. The URL never changes.
 */
export function SavedConversationPage() {
  const { savedId } = useParams<{ savedId: string }>();
  return <ConsolePage savedSessionId={savedId} />;
}
