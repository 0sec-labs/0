import { Link } from "react-router-dom";
import { FileQuestion } from "lucide-react";
import { Button } from "@/ui/components/button";

/** Unknown URLs land here instead of silently rendering the home page. */
export function NotFoundPage() {
  return <div role="status" data-page="not-found" className="flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
    <FileQuestion aria-hidden="true" className="size-6 text-muted-foreground-2" />
    <p className="text-sm font-medium text-foreground">Page not found</p>
    <Button variant="outline" size="sm" render={<Link to="/chats" />}>Go home</Button>
  </div>;
}
