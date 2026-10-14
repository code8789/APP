import { createFileRoute } from '@tanstack/react-router';
import { TeachApp } from '../components/teach/teach-app';

export const Route = createFileRoute('/')({
  component: IndexRoute,
});

function IndexRoute() {
  return <TeachApp />;
}
