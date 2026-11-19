import { getCapabilities } from '@/lib/config';
import GeneralClient from './general-client';

export default function GeneralPage() {
  return <GeneralClient emailConfirmationAvailable={
    getCapabilities().transactionalEmail.configured
  } />;
}
