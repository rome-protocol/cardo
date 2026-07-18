import { redirect } from 'next/navigation';

// `/pool` has no UI of its own — pool creation lives at `/pool/new`. Without
// this, `/pool` 404s (the internal test-index links to it). Redirect so the
// route resolves instead of dead-ending.
export default function Page() {
  redirect('/pool/new');
}
