import { PageHeader, PageContent } from "@/components/page-header";
import { MemoryPortability } from "@/components/memory-portability";
import { LearningPanel } from "@/components/learning-panel";
export function LearningPage() {
  return <PageContent><PageHeader title="Lessons" actions={<MemoryPortability />} /><LearningPanel /></PageContent>;
}
