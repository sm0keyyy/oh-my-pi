import { isRecord } from "@oh-my-pi/web-render";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { records, text, type RecordValue, type SessionClient } from "./client";

export function Modal({
	title,
	children,
	onClose,
}: {
	title: string;
	children: ReactNode;
	onClose(): void;
}): ReactNode {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		ref.current?.showModal();
		return () => ref.current?.close();
	}, []);
	return (
		<dialog className="panel-dialog" ref={ref} onCancel={onClose}>
			<div className="dlg-head">
				{title}
				<span className="top-spacer" />
				<button type="button" className="btn btn-icon" aria-label={`Close ${title}`} onClick={onClose}>
					×
				</button>
			</div>
			{children}
		</dialog>
	);
}

export function OperatorDialog({ frame, client }: { frame: RecordValue; client: SessionClient }): ReactNode {
	const [error, setError] = useState("");
	const ref = useRef<HTMLFormElement>(null);
	const method = text(frame.method);
	const id = text(frame.id);
	const questions = method === "ask" ? records(frame.questions) : [];
	useEffect(() => {
		ref.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
	}, []);
	const decline = () => {
		try {
			client.answer({ type: "extension_ui_response", id, cancelled: true });
		} catch (error) {
			setError(String(error));
		}
	};
	return (
		<form
			className="dlg"
			ref={ref}
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.preventDefault();
					decline();
				}
			}}
			onSubmit={event => {
				event.preventDefault();
				const data = new FormData(event.currentTarget);
				try {
					if (method === "ask")
						client.answer({
							type: "extension_ui_response",
							id,
							answers: questions.map(question => ({
								id: text(question.id),
								selectedOptions: data.getAll(text(question.id)).map(String),
								customInput: String(data.get(`${question.id}-custom`) ?? ""),
							})),
						});
					else if (method === "confirm") client.answer({ type: "extension_ui_response", id, confirmed: true });
					else client.answer({ type: "extension_ui_response", id, value: String(data.get("value") ?? "") });
				} catch (error) {
					setError(String(error));
				}
			}}
		>
			<div className="dlg-box">
				<div className="dlg-head">
					<span className="dot dot-warn" />
					{method === "ask" ? "omp asks" : text(frame.title)}
					<span className="src">
						{method}
						{frame.timeout ? ` · ${Math.ceil(Number(frame.timeout) / 1000)} s limit` : ""}
					</span>
				</div>
				<div className="dlg-scroll">
					{method === "ask" &&
						questions.map((question, index) => (
							<fieldset className="dlg-q" key={text(question.id)}>
								<legend>
									<span className="num">
										{index + 1} of {questions.length} ·{" "}
									</span>
									{text(question.question)}
								</legend>
								<div className="opts">
									{records(question.options).map((option, i) => (
										<label className="opt" key={text(option.label)}>
											<input
												type={question.multi ? "checkbox" : "radio"}
												name={text(question.id)}
												value={text(option.label)}
												defaultChecked={question.recommended === i}
											/>
											<span className="lab">
												{text(option.label)}
												{question.recommended === i && <span className="rec">recommended</span>}
											</span>
											{Boolean(option.description) && (
												<span className="desc">{text(option.description)}</span>
											)}
											{Boolean(option.preview) && <pre className="desc">{text(option.preview)}</pre>}
										</label>
									))}
								</div>
								<label className="field">
									Note to the agent
									<input name={`${question.id}-custom`} />
								</label>
							</fieldset>
						))}
					{method === "confirm" && <p className="dlg-q">{text(frame.message)}</p>}
					{method === "select" && (
						<fieldset className="dlg-q">
							<legend>{text(frame.title)}</legend>
							<div className="opts">
								{Array.isArray(frame.options) &&
									frame.options.map((option, index) => (
										<label className="opt" key={String(option)}>
											<input type="radio" name="value" value={String(option)} defaultChecked={index === 0} />
											<span className="lab">{String(option)}</span>
											{Array.isArray(frame.optionDetails) && isRecord(frame.optionDetails[index]) && (
												<span className="desc">{text(frame.optionDetails[index].description)}</span>
											)}
										</label>
									))}
							</div>
						</fieldset>
					)}
					{(method === "input" || method === "editor") && (
						<label className="dlg-q field">
							{text(frame.title)}
							{method === "editor" ? (
								<textarea name="value" rows={6} defaultValue={text(frame.prefill)} />
							) : (
								<input name="value" placeholder={text(frame.placeholder)} />
							)}
						</label>
					)}
				</div>
				{error && (
					<p role="alert" className="composer-note err">
						{error}
					</p>
				)}
				<div className="dlg-act">
					<button className="btn btn-primary" type="submit">
						{method === "ask"
							? "Answer"
							: method === "confirm"
								? "Yes"
								: method === "select"
									? "Choose"
									: "Submit"}
					</button>
					<button
						className="btn"
						type="button"
						onClick={() => {
							if (method === "confirm") {
								try {
									client.answer({ type: "extension_ui_response", id, confirmed: false });
								} catch (error) {
									setError(String(error));
								}
							} else decline();
						}}
					>
						{method === "confirm" ? "No" : "Decline"}
					</button>
				</div>
			</div>
		</form>
	);
}
