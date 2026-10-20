import { useState } from "react";
import { store, useCluster } from "../engine/store";
import { Badge, Card, Seg, clockTime } from "../components/ui";
import { Icon } from "../components/icons";
import { useOpenJob } from "../components/cluster";

const FILTERS = ["All", "Users", "Admin"] as const;

export default function Mail() {
  const c = useCluster();
  const openJob = useOpenJob();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [selected, setSelected] = useState<number | null>(null);
  const list = c.emails.filter((e) => filter === "All" || (filter === "Users" ? e.kind === "user" : e.kind === "admin"));
  const mail = list.find((e) => e.id === selected) ?? list[0];
  const headline = mail?.body.split("\n").find((l, i) => i > 0 && l.trim()) ?? "";

  const select = (id: number) => {
    setSelected(id);
    store.act((c) => {
      const e = c.emails.find((x) => x.id === id);
      if (e) e.read = true;
    });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p>
            Every email the autopilot sends: job owners when a job ends, the admin when a node is drained, fails or comes back.{" "}
            {c.settings.realEmail ? "Real delivery is on (via /api/send-email)." : "Emails are kept in this outbox; turn on real delivery in Automation."}
          </p>
        </div>
        <div className="actions">
          <Seg label="Filter" options={FILTERS} value={filter} onChange={setFilter} />
          <button className="btn" onClick={() => store.act((c) => c.emails.forEach((e) => (e.read = true)))}>
            <Icon name="check" /> Mark all read
          </button>
        </div>
      </div>

      <Card flush>
        {list.length ? (
          <div className="mail">
            <div className="mail-list">
              {list.map((e) => (
                <button key={e.id} type="button" className={`mail-item ${e.read ? "" : "unread"}`} aria-current={mail?.id === e.id} onClick={() => select(e.id)}>
                  <div className="subj">{e.subject}</div>
                  <div className="meta">
                    <span>{e.to}</span>
                    <span className="mono">{clockTime(e.time)}</span>
                  </div>
                </button>
              ))}
            </div>
            {mail && (
              <article className="mail-view">
                <div className="row">
                  <Badge value={mail.kind === "admin" ? "admin alert" : "job notice"} tone={mail.kind === "admin" ? "t-warn" : "t-ok"} plain />
                  <Badge value={mail.delivery} />
                  {mail.jobId && (
                    <button className="btn sm ghost" onClick={() => openJob(mail.jobId!)}>
                      Open job {mail.jobId}
                    </button>
                  )}
                </div>
                <div className="mail-headline">{headline}</div>
                <dl className="kv">
                  <dt>From</dt>
                  <dd>hpc-autopilot@example.edu</dd>
                  <dt>To</dt>
                  <dd>{mail.to}</dd>
                  <dt>Subject</dt>
                  <dd>{mail.subject}</dd>
                  <dt>Date</dt>
                  <dd>{new Date(mail.time * 1000).toLocaleString("en-GB")}</dd>
                </dl>
                <pre>{mail.body}</pre>
              </article>
            )}
          </div>
        ) : (
          <div className="empty">
            <Icon name="inbox" size={28} />
            <p>No emails yet. They appear as soon as a job finishes.</p>
          </div>
        )}
      </Card>
    </>
  );
}
