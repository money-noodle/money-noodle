export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <main className="grid min-h-screen place-items-center bg-background px-4">
    <form action="/api/auth/login" method="post" className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-lg">
      <p className="text-sm font-semibold"><span className="text-primary">Money</span> <span className="text-brand-green">Noodle</span></p>
      <h1 className="mt-6 text-xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">Enter the dashboard password to access trading controls and account data.</p>
      {error && <p className="mt-4 rounded-md border border-loss/30 bg-loss/10 p-3 text-sm text-loss">Invalid password or authentication is not configured.</p>}
      <label className="mt-5 block text-sm font-medium" htmlFor="password">Password</label>
      <input className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring" id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
      <button className="mt-5 h-10 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" type="submit">Sign in</button>
    </form>
  </main>;
}