import { PageHeader, PageContent } from "@/components/page-header";
import { MemoryPortability } from "@/components/memory-portability";
import { LearningPanel } from "@/components/learning-panel";
export function LearningPage() {
  return <PageContent><PageHeader title="Memory" summary="Saved codebase lessons for future investigations. Current lessons can be reused when their cited files still match." actions={<MemoryPortability />} /><LearningPanel /></PageContent>;
}
