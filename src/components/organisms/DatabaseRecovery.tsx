import { useEffect, useRef } from "react";
import type { DatabaseProblem, RecoveryStep } from "@/bindings";
import { FluentLibraryFilled } from "@/components/icons/FluentLibraryFilled";
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

const ShelfMark = () => (
	<FluentLibraryFilled fontSize={28} aria-hidden="true" />
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
					<div className={card.mark}>
						<ShelfMark />
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
