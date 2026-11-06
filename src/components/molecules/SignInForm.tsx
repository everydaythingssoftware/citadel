import { type FormEvent, useState } from "react";
import { FluentLibraryFilled } from "@/components/icons/FluentLibraryFilled";
import { Button, TextInput } from "@/components/ui";
import styles from "./SignInForm.module.css";

export interface SignInFormProps {
	onSubmit: (username: string, password: string) => void;
	pending: boolean;
	error: string | null;
}

export const SignInForm = ({ onSubmit, pending, error }: SignInFormProps) => {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		onSubmit(username, password);
	};
	return (
		<main className={styles.root}>
			<form className={styles.card} onSubmit={submit} aria-busy={pending}>
				<div className={styles.mark} aria-hidden="true">
					<FluentLibraryFilled fontSize={28} />
				</div>
				<h1 className={styles.title}>Sign in to Citadel</h1>
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
					autoComplete="current-password"
					required
					value={password}
					onChange={(event) => setPassword(event.currentTarget.value)}
				/>
				{/* Always present, so a message appears without the card moving. */}
				<p role="alert" className={styles.error}>
					{error}
				</p>
				<Button type="submit" variant="primary" fullWidth disabled={pending}>
					{pending ? "Signing in…" : "Sign In"}
				</Button>
			</form>
		</main>
	);
};
