import LibraryClient from '@/components/books/library-client';
import { guardToolPage } from '@/lib/subscription/page-access';

export default async function LibraryPage() {
  await guardToolPage();
  return <LibraryClient />;
}
