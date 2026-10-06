// Sign out from a plain form post.
//
// An HTML form can only send GET or POST, and the sign-out button must work
// without JavaScript, so the revocation that `/session`'s `DELETE` performs for a
// JSON client is reached through a POST here. Same work, same shared function,
// different carrier.

import { endSession } from '../route';

export async function POST(): Promise<Response> {
  const outcome = await endSession();
  return new Response(null, {
    headers: { location: outcome === 'revoked' ? '/control' : '/control?signOut=unconfirmed' },
    status: 303,
  });
}
