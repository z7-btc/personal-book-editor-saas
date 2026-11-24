import SettingsClient from '@/components/books/settings-client';
import { guardToolPage } from '@/lib/subscription/page-access';

export default async function BookSettingsPage() {
  await guardToolPage();
  return <SettingsClient />;
}
