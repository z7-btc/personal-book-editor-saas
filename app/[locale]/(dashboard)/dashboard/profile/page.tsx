import ProfileClient from '@/components/books/profile-client';
import { guardToolPage } from '@/lib/subscription/page-access';

export default async function ReaderProfilePage() {
  await guardToolPage();
  return <ProfileClient />;
}
