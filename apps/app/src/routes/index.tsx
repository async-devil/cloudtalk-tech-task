import { Card, CardContent } from '@repo/styles';
import { createFileRoute } from '@tanstack/react-router';
import { useSession } from '../shared/session/index.js';

export const Route = createFileRoute('/')({
  component: HomeRoute,
});

/**
 * The signed-in landing screen — a route module, so it composes and owns nothing. It exists to
 * give the guard chain a real protected destination.
 */
function HomeRoute() {
  const session = useSession();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          {session === undefined ? (
            <p>Loading…</p>
          ) : (
            // The user's PUBLIC token — the only user identifier this app ever holds.
            <p data-testid="session-user-token">{session.userToken}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
