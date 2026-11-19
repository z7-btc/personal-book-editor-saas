import BookClient from '@/components/books/book-client';

export default async function BookPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <BookClient bookId={decodeURIComponent(bookId)} />;
}
