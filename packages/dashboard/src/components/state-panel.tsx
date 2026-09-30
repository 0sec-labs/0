import type { ReactNode } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";

export function LoadingState({ label }: { label: string }) {
  return (
    <Card className="border border-border">
      <CardContent className="flex min-h-[10rem] flex-col items-center justify-center gap-4 text-center">
        <LoaderCircle className="size-8 animate-spin text-primary-text" />
        <div>
          <CardTitle>{label}</CardTitle>
        </div>
      </CardContent>
    </Card>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <Card className="border border-dashed border-border bg-muted/20">
      <CardContent className="flex min-h-[10rem] flex-col items-center justify-center gap-3 text-center">
        <div>
          <CardTitle>{title}</CardTitle>
          {body ? <CardDescription>{body}</CardDescription> : null}
        </div>
        {action ?? null}
      </CardContent>
    </Card>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    <Card className="border border-destructive/25">
      <CardContent className="flex min-h-[10rem] flex-col items-center justify-center gap-4 text-center">
        <AlertTriangle className="size-8 text-destructive" />
        <div>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </div>
      </CardContent>
    </Card>
  );
}
