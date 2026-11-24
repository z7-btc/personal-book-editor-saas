import BookClient from '@/components/books/book-client';
import { guardToolPage } from '@/lib/subscription/page-access';

export default async function BookPage({ params }: { params: Promise<{ bookId: string }> }) {
  await guardToolPage();
  const { bookId } = await params;
  return <BookClient bookId={decodeURIComponent(bookId)} />;
}
