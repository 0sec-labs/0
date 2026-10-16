import { PageHeader } from "@/components/page-header";
import { LearningPanel } from "@/components/learning-panel";
export function LearningPage() {
  return <div className="w-full min-w-0 space-y-6"><PageHeader title="Learning" summary="What 0 has learned for future investigations." /><LearningPanel /></div>;
}
