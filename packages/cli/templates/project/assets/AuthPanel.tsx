import { Button, Flex, Text, TextInput } from "@gravity-ui/uikit";
import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client";

export function AuthPanel() {
  const session = authClient.useSession();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  if (session.isPending) return <Text color="secondary">Loading account…</Text>;
  if (session.data) {
    return (
      <Flex alignItems="center" gap={3}>
        <Text>Signed in as {session.data.user.email}</Text>
        <Button view="outlined" onClick={() => void authClient.signOut()}>Sign out</Button>
      </Flex>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email || !password || (mode === "sign-up" && !name)) {
      setError("Complete all fields");
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const result = mode === "sign-up"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });
      if (result.error) setError(result.error.message ?? "Authentication failed");
    } catch {
      setError("Authentication is unavailable");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <Flex alignItems="stretch" direction="column" gap={3}>
        {mode === "sign-up" && <TextInput label="Name" value={name} onUpdate={setName} />}
        <TextInput label="Email" type="email" value={email} onUpdate={setEmail} />
        <TextInput label="Password" type="password" value={password} onUpdate={setPassword} />
        {error && <Text color="danger">{error}</Text>}
        <Flex gap={2}>
          <Button type="submit" view="action" loading={pending}>
            {mode === "sign-up" ? "Create account" : "Sign in"}
          </Button>
          <Button
            type="button"
            view="flat"
            onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
          >
            {mode === "sign-in" ? "Create account" : "Use existing account"}
          </Button>
        </Flex>
      </Flex>
    </form>
  );
}
