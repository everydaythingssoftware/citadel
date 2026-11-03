import { type FormEvent, useState } from "react";
import { Button, TextInput } from "@/components/ui";
import styles from "./SignInForm.module.css";

export interface AdministratorSetupFormProps {
	onSubmit: (setupCode: string, username: string, password: string) => void;
	pending: boolean;
	error: string | null;
}

/** A fresh server's first screen: the printed setup code makes the administrator. */
export const AdministratorSetupForm = ({
	onSubmit,
	pending,
	error,
}: AdministratorSetupFormProps) => {
	const [setupCode, setSetupCode] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		onSubmit(setupCode, username, password);
	};
	return (
		<main className={styles.root}>
			<form className={styles.card} onSubmit={submit} aria-busy={pending}>
				<h1 className={styles.title}>Set up Citadel</h1>
				<p className={styles.lede}>
					This server has no administrator yet. Enter the setup code it printed
					when it started, then choose your name and password.
				</p>
				<TextInput
					label="Setup code"
					name="setupCode"
					autoComplete="one-time-code"
					autoCapitalize="characters"
					spellCheck={false}
					placeholder="K7QD-M2XV-H9RW"
					required
					value={setupCode}
					onChange={(event) => setSetupCode(event.currentTarget.value)}
				/>
				<TextInput
					label="Username"
					name="username"
					autoComplete="username"
					autoCapitalize="none"
					spellCheck={false}
					required
					value={username}
					onChange={(event) => setUsername(event.currentTarget.value)}
				/>
				<TextInput
					label="Password"
					name="password"
					type="password"
					autoComplete="new-password"
					required
					minLength={8}
					value={password}
					onChange={(event) => setPassword(event.currentTarget.value)}
				/>
				{error && (
					<p role="alert" className={styles.error}>
						{error}
					</p>
				)}
				<Button type="submit" variant="primary" fullWidth disabled={pending}>
					{pending ? "Creating…" : "Create Administrator"}
				</Button>
			</form>
		</main>
	);
};
