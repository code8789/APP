import { createFileRoute } from '@tanstack/react-router';
import { TeachApp } from '../components/teach/teach-app';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return <TeachApp />;
}
