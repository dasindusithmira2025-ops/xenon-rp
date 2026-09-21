import { StatusPage } from '~/components/site/status-pages';

export default function NotFound(): React.ReactElement {
  return (
    <StatusPage
      code="404"
      title="This street does not exist"
      description="The page you were looking for has moved, been retired, or never existed. The city is still here."
    />
  );
}
