// ============================================================
// Resume Screener Tool — admin-users Edge Function
// Lets an ADMIN manage logins entirely from the website:
//   - list users
//   - create user (email + temporary password, NO email sent)
//   - reset a user's password
//   - set a user's role (admin/user)
//   - delete a user
// The service_role key stays here on the server (never in the browser).
// The caller's admin status is verified before any action runs.
//
// Roles are ONLY 'admin' or 'user'. The sole admin-only power is managing users.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const ROLES = ["admin", "user"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // 1) Identify the caller from their JWT.
    const authHeader = req.headers.get("Authorization") || "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Not signed in" }, 401);

    // 2) Verify the caller is an admin (service-role read of their profile).
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: prof } = await admin
      .from("profiles").select("role").eq("id", userData.user.id).single();
    if (!prof || prof.role !== "admin") return json({ error: "Admins only" }, 403);

    // 3) Perform the requested action.
    const body = await req.json();
    const action = body.action;

    if (action === "list") {
      const { data, error } = await admin.auth.admin.listUsers();
      if (error) throw error;
      const { data: profiles } = await admin.from("profiles").select("*");
      const byId: Record<string, any> = {};
      (profiles || []).forEach((p: any) => (byId[p.id] = p));
      const users = data.users.map((u) => ({
        id: u.id, email: u.email,
        name: byId[u.id]?.name || u.email,
        role: byId[u.id]?.role || "user",
      }));
      return json({ users });
    }

    if (action === "create") {
      const { email, password, name } = body;
      let { role } = body;
      if (!email || !password) return json({ error: "Email and password required" }, 400);
      if (!ROLES.includes(role)) role = "user";
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, // active immediately, no email
        user_metadata: { name: name || email.split("@")[0], role },
      });
      if (error) throw error;
      await admin.from("profiles").upsert({
        id: data.user.id, name: name || email.split("@")[0], role,
      });
      return json({ ok: true, id: data.user.id });
    }

    if (action === "resetPassword") {
      const { userId, newPassword } = body;
      if (!userId || !newPassword) return json({ error: "userId and newPassword required" }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "setRole") {
      const { userId, role } = body;
      if (!userId || !ROLES.includes(role)) return json({ error: "Valid userId and role required" }, 400);
      // Don't allow removing the last admin.
      if (role !== "admin") {
        const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin");
        if ((admins || []).length <= 1 && (admins || [])[0]?.id === userId) {
          return json({ error: "Can't demote the last admin." }, 400);
        }
      }
      const { error } = await admin.from("profiles").update({ role }).eq("id", userId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete") {
      const { userId } = body;
      if (!userId) return json({ error: "userId required" }, 400);
      if (userId === userData.user.id) return json({ error: "You can't delete yourself" }, 400);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Server error" }, 500);
  }
});
