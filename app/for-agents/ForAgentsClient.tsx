'use client';

import { useRouter } from 'next/navigation';
import { ForAgents } from '@/components/screens/ForAgents';

export default function ForAgentsClient() {
  const router = useRouter();
  return <ForAgents onNav={(path: string) => router.push(path)} />;
}
