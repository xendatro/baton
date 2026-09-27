import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  Link,
  Outlet,
  RouterProvider,
  useSearchParams,
  type RouteObject,
} from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetNavigationHistory,
  resolveBackTarget,
  useNavigationHistory,
} from '@web/lib/navigationHistory';
import { BackLink } from './BackLink';

describe('resolveBackTarget', () => {
  const options = {
    to: '/t/acme/p/WEB/issues',
    label: 'Issues',
    also: [{ pathname: '/my-tasks', label: 'My tasks' }],
  };

  it('goes to the section list when nothing came before', () => {
    expect(resolveBackTarget(null, options)).toEqual({
      href: '/t/acme/p/WEB/issues',
      label: 'Issues',
      fromHistory: false,
    });
  });

  it('returns to the previous entry, filters included, when it is the list', () => {
    expect(
      resolveBackTarget({ pathname: '/t/acme/p/WEB/issues', search: '?label=bug' }, options),
    ).toEqual({ href: '/t/acme/p/WEB/issues?label=bug', label: 'Issues', fromHistory: true });
  });

  it('names another list the page was opened from', () => {
    expect(resolveBackTarget({ pathname: '/my-tasks', search: '?q=x' }, options)).toEqual({
      href: '/my-tasks?q=x',
      label: 'My tasks',
      fromHistory: true,
    });
  });

  it('ignores a previous entry that is not one of the lists', () => {
    expect(
      resolveBackTarget({ pathname: '/t/acme/p/WEB/issues/3', search: '' }, options),
    ).toMatchObject({ href: '/t/acme/p/WEB/issues', fromHistory: false });
  });

  it('matches the list by path, whatever query string the fallback carries', () => {
    expect(
      resolveBackTarget(
        { pathname: '/t/acme/p/WEB/tasks', search: '?q=new' },
        { to: '/t/acme/p/WEB/tasks?q=old', label: 'Board' },
      ),
    ).toMatchObject({ href: '/t/acme/p/WEB/tasks?q=new', fromHistory: true });
  });
});

function Shell() {
  useNavigationHistory();
  return <Outlet />;
}

function ListPage() {
  const [params, setParams] = useSearchParams();
  return (
    <div>
      <h1>List {params.get('state') ?? 'all'}</h1>
      <button type="button" onClick={() => setParams({ state: 'closed' }, { replace: true })}>
        Only closed
      </button>
      <Link to="/items/1">Item 1</Link>
    </div>
  );
}

const routes: RouteObject[] = [
  {
    element: <Shell />,
    children: [
      { path: '/list', element: <ListPage /> },
      { path: '/other', element: <Link to="/items/1">Item 1</Link> },
      {
        path: '/items/:id',
        element: (
          <div>
            <BackLink to="/list" label="Items" />
            <h1>Item</h1>
          </div>
        ),
      },
    ],
  },
];

function setup(start: string) {
  const router = createMemoryRouter(routes, { initialEntries: [start] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

describe('BackLink', () => {
  beforeEach(() => {
    resetNavigationHistory();
  });

  it('returns to the list it was opened from with the filters it had', async () => {
    const { router, user } = setup('/list');
    await user.click(await screen.findByRole('button', { name: 'Only closed' }));
    await user.click(screen.getByRole('link', { name: 'Item 1' }));

    const back = await screen.findByRole('link', { name: 'Back to Items' });
    expect(back).toHaveAttribute('href', '/list?state=closed');
    expect(back).toHaveAttribute('aria-keyshortcuts', 'u');
    await user.click(back);

    expect(await screen.findByRole('heading', { name: 'List closed' })).toBeInTheDocument();
    expect(router.state.historyAction).toBe('POP');
    expect(router.state.location.search).toBe('?state=closed');
  });

  it('goes to the section list when the page was opened directly', async () => {
    const { router, user } = setup('/items/1');
    const back = await screen.findByRole('link', { name: 'Back to Items' });
    expect(back).toHaveAttribute('href', '/list');
    await user.click(back);

    expect(await screen.findByRole('heading', { name: 'List all' })).toBeInTheDocument();
    expect(router.state.historyAction).toBe('PUSH');
  });

  it('goes to the section list when the previous page is not the list', async () => {
    const { user } = setup('/other');
    await user.click(await screen.findByRole('link', { name: 'Item 1' }));
    expect(await screen.findByRole('link', { name: 'Back to Items' })).toHaveAttribute(
      'href',
      '/list',
    );
  });

  it('follows `u`, but not while typing', async () => {
    const { router, user } = setup('/list?state=closed');
    await user.click(await screen.findByRole('link', { name: 'Item 1' }));
    await screen.findByRole('heading', { name: 'Item' });

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    await user.keyboard('u');
    expect(router.state.location.pathname).toBe('/items/1');
    input.remove();

    await act(async () => {
      await user.keyboard('u');
    });
    expect(await screen.findByRole('heading', { name: 'List closed' })).toBeInTheDocument();
    expect(router.state.historyAction).toBe('POP');
  });
});
