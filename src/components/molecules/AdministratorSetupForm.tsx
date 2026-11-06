import { type FormEvent, useState } from "react";
import { FluentLibraryFilled } from "@/components/icons/FluentLibraryFilled";
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
				<div className={styles.mark} aria-hidden="true">
					<FluentLibraryFilled fontSize={28} />
				</div>
				<h1 className={styles.title}>Set up Citadel</h1>
				<TextInput
					label="Setup code"
					name="setupCode"
					hint="Printed in the server's output when it started."
					autoComplete="one-time-code"
					autoCapitalize="characters"
					spellCheck={false}
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
					hint="At least 8 characters."
					value={password}
					onChange={(event) => setPassword(event.currentTarget.value)}
				/>
				{/* Always present, so a message appears without the card moving. */}
				<p role="alert" className={styles.error}>
					{error}
				</p>
				<Button type="submit" variant="primary" fullWidth disabled={pending}>
					{pending ? "Creating…" : "Create Administrator"}
				</Button>
			</form>
		</main>
	);
};
