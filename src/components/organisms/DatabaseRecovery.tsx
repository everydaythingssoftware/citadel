import clsx from "clsx";
import { useEffect, useRef } from "react";
import type { DatabaseProblem, RecoveryStep } from "@/bindings";
import { Button, Spinner } from "@/components/ui";
import {
	FAILED_PREFIX,
	formatBackupDate,
	PROBLEM_COPY,
	QUIT_LABEL,
	STEP_COPY,
	WORKING_LABEL,
} from "@/lib/database-recovery/copy";
import { useDatabaseRecovery } from "@/lib/hooks/use-database-recovery";
import styles from "./DatabaseRecovery.module.css";
import card from "./FirstRunFlow.module.css";

const AlertMark = () => (
	<svg
		width="28"
		height="28"
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M8 1.6c.5 0 1 .3 1.3.8l5.3 9.6c.5 1-.2 2.2-1.3 2.2H2.7c-1.1 0-1.8-1.2-1.3-2.2L6.7 2.4c.3-.5.8-.8 1.3-.8zM8 6a.7.7 0 0 0-.7.7v2.6a.7.7 0 0 0 1.4 0V6.7A.7.7 0 0 0 8 6zm0 5.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z" />
	</svg>
);

const ChevronRight = () => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.7"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M6 3.5 10.5 8 6 12.5" />
	</svg>
);

export interface DatabaseRecoveryCardProps {
	problem: DatabaseProblem;
	running: RecoveryStep | null;
	error: string | null;
	onRecover: (step: RecoveryStep) => void;
}

export const DatabaseRecoveryCard = ({
	problem,
	running,
	error,
	onRecover,
}: DatabaseRecoveryCardProps) => {
	const copy = PROBLEM_COPY[problem.kind];
	const backupDate = formatBackupDate(problem.backup?.createdAt ?? null);
	const busy = running !== null;
	const steps = problem.steps.filter(
		(step): step is Exclude<RecoveryStep, "quit"> => step !== "quit",
	);

	const cardRef = useRef<HTMLElement>(null);
	useEffect(() => {
		cardRef.current
			?.querySelector<HTMLElement>("[data-autofocus]")
			?.focus({ preventScroll: true });
	}, []);

	return (
		<div className={card.layer}>
			<section ref={cardRef} className={card.card} aria-label={copy.title}>
				<div className={styles.body}>
					<div className={clsx(card.mark, styles.mark)}>
						<AlertMark />
					</div>
					<h1 className={card.title}>{copy.title}</h1>
					<p className={card.lede}>{copy.lede}</p>
					{steps.length > 0 && (
						<div className={card.choices}>
							{steps.map((step, index) => (
								<button
									key={step}
									type="button"
									className={card.choice}
									disabled={busy}
									data-autofocus={index === 0 || undefined}
									onClick={() => onRecover(step)}
								>
									<span>
										<span className={card.choiceTitle}>
											{STEP_COPY[step].title(backupDate)}
										</span>
										{(running === step || STEP_COPY[step].description) && (
											<>
												<br />
												<span className={card.choiceDesc}>
													{running === step
														? WORKING_LABEL
														: STEP_COPY[step].description}
												</span>
											</>
										)}
									</span>
									<span className={card.choiceChevron}>
										{running === step ? (
											<Spinner size={12} />
										) : (
											<ChevronRight />
										)}
									</span>
								</button>
							))}
						</div>
					)}
					{error && (
						<p className={card.err} role="alert">
							{FAILED_PREFIX} {error}
						</p>
					)}
					<div className={card.divider} />
					<div className={styles.quit}>
						<Button
							variant="subtle"
							size="sm"
							className={card.escapeBtn}
							disabled={busy}
							data-autofocus={steps.length === 0 || undefined}
							onClick={() => onRecover("quit")}
						>
							{QUIT_LABEL}
						</Button>
					</div>
				</div>
			</section>
		</div>
	);
};

export const DatabaseRecoveryScreen = ({
	problem,
}: {
	problem: DatabaseProblem;
}) => {
	const { running, error, recover } = useDatabaseRecovery(problem);
	return (
		<DatabaseRecoveryCard
			problem={problem}
			running={running}
			error={error}
			onRecover={recover}
		/>
	);
};
