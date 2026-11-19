// CIRCArt — email sign-in in online.js (19 Nov 2026).
// Bug: a device that had played as a guest could never sign in to an account
// that already existed ("A user with this email address has already been
// registered"), so a second device, or the same device after signing out and
// playing once, was locked out. This replays those cases against a fake
// Supabase client that behaves like the real one.
import fs from "fs"; import path from "path"; import vm from "vm";

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };
const MIG = process.argv[2];
const src = fs.readFileSync(path.join(MIG, "..", "..", "web", "online.js"), "utf8")
  .replace("'https://YOUR-PROJECT.supabase.co'", "'https://test.supabase.co'");

// ─── fake auth server ───
function makeWorld() {
  const accounts = new Map();                 // email -> { id }
  const calls = [];
  const sent = [];                            // { email, type }
  let session = null;                         // { user }
  let n = 0;
  const auth = {
    async getSession() { return { data: { session } }; },
    onAuthStateChange() {},
    async signInAnonymously() { session = { user: { id: "guest" + (++n), is_anonymous: true } }; calls.push("anon"); return { data: { user: session.user }, error: null }; },
    async updateUser({ email }, opts) {
      calls.push("updateUser");
      if (accounts.has(email)) return { error: { code: "email_exists", message: "A user with this email address has already been registered" } };
      sent.push({ email, type: "email_change", redirect: opts && opts.emailRedirectTo });
      return { error: null };
    },
    async signInWithOtp({ email, options }) {
      calls.push("otp");
      sent.push({ email, type: "email", redirect: options && options.emailRedirectTo });
      return { error: null };
    },
    async verifyOtp({ email, token, type }) {
      calls.push("verify:" + type);
      const last = [...sent].reverse().find(s => s.email === email);
      if (token !== "123456" || !last || last.type !== type) return { error: { code: "otp_expired", message: "Token has expired or is invalid" } };
      if (type === "email_change") { accounts.set(email, { id: session.user.id }); session = { user: { id: session.user.id, is_anonymous: false, email } }; }
      else { if (!accounts.has(email)) accounts.set(email, { id: "acct" + (++n) }); session = { user: { id: accounts.get(email).id, is_anonymous: false, email } }; }
      return { error: null };
    },
    async signOut() { session = null; },
  };
  const store = {};
  const window = {
    supabase: { createClient: () => ({ auth, rpc: async () => ({ data: null, error: null }) }) },
    addEventListener() {}, crypto: { randomUUID: () => "u" + (++n) },
  };
  const ctx = {
    window, console, URL, setTimeout, clearTimeout,
    location: { origin: "https://nambatu.github.io", pathname: "/circart-preview/" },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    navigator: { onLine: true, userAgent: "test" }, document: { dispatchEvent() {} }, CustomEvent: class {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { o: window.CircOnline, accounts, calls, sent, me: () => session && session.user };
}
const code = async f => { try { await f(); return null; } catch (e) { return e.code; } };

// 1. new player, guest first, new email → email attached to the guest (games kept)
{
  const w = makeWorld();
  await w.o.ensureGuest();
  const mode = await w.o.signInWithEmail("New@Example.com ");
  ok(mode === "attach", "guest + new email: attached to the guest account");
  ok(w.sent[0].redirect === "https://nambatu.github.io/circart-preview/", "the email links back to this site");
  await w.o.verifyEmailCode("new@example.com", "123 456", mode);
  ok(w.me().id === "guest1" && !w.me().is_anonymous, "after the code: same account, now with email");
}

// 2. THE BUG: second device played as a guest, email already has an account
{
  const w = makeWorld();
  w.accounts.set("julian@example.com", { id: "acct-julian" });
  await w.o.ensureGuest();
  const mode = await w.o.signInWithEmail("julian@example.com");
  ok(mode === "existing", "guest + existing email: no error, signs in to the existing account");
  ok(w.calls.includes("updateUser") && w.calls.includes("otp"), "tries to attach first, then falls back to a normal sign-in");
  await w.o.verifyEmailCode("julian@example.com", "123456", mode);
  ok(w.me().id === "acct-julian", "after the code: this device is on the existing account");
}

// 3. signed out, no guest → plain sign-in
{
  const w = makeWorld();
  w.accounts.set("julian@example.com", { id: "acct-julian" });
  const mode = await w.o.signInWithEmail("julian@example.com");
  ok(mode === "signin" && !w.calls.includes("updateUser"), "signed out: normal sign-in");
  await w.o.verifyEmailCode("julian@example.com", "123456", mode);
  ok(w.me().id === "acct-julian", "signed in to the account");
  await w.o.signOut();
  await w.o.ensureGuest();                                   // played once after signing out
  const m2 = await w.o.signInWithEmail("julian@example.com");
  await w.o.verifyEmailCode("julian@example.com", "123456", m2);
  ok(w.me().id === "acct-julian", "sign out, play as guest, sign in again: back on the same account");
}

// 4. errors
{
  const w = makeWorld();
  ok(await code(() => w.o.signInWithEmail("not-an-email")) === "email_address_invalid", "a broken address is refused before sending");
  await w.o.signInWithEmail("x@example.com");
  ok(await code(() => w.o.verifyEmailCode("x@example.com", "999999", "signin")) === "otp_expired", "a wrong code gives a clear message");
  ok(await code(() => w.o.verifyEmailCode("x@example.com", "12", "signin")) === "otp_expired", "a too-short code is refused");
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
