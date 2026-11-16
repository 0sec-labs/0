import { PageHeader } from "@/components/page-shell";
import { MemoryPortability } from "@/components/memory-portability";
import { LearningPanel } from "@/components/learning-panel";
export function LearningPage() {
  return <><PageHeader title="Memory" actions={<MemoryPortability />} /><LearningPanel /></>;
}
