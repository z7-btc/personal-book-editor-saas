import PromptsClient from '@/components/books/prompts-client';
import { guardToolPage } from '@/lib/subscription/page-access';

export default async function PromptsPage() {
  await guardToolPage();
  return <PromptsClient />;
}
