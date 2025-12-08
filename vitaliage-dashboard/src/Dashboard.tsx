import React, { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine
} from "recharts";

const API_BASE = "https://vitaliage.onrender.com";

interface SleepDTO {
  totalMinutes: number;
  goalMinutes: number;
  metGoal: boolean;
  date?: string;
  id?: string;
}

interface DailySnapshotDTO {
  id: string;
  userId: string | null;
  date: string;

  steps: number | null;
  restingHR: number | null;
  vo2Max: number | null;
  hrv: number | null;
  respiratoryRate: number | null;
  activityEnergy: number | null;
  standHours: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  glucoseMgDl: number | null;

  sleep: SleepDTO | null;

  raw?: unknown;
}

interface DailySnapshotsResponse {
  ok: boolean;
  snapshots: DailySnapshotDTO[];
}

function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function formatMinutesToHhMm(minutes: number | null | undefined): string {
  if (!minutes && minutes !== 0) return "—";
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hrs}h ${mins.toString().padStart(2, "0")}m`;
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function formatFullDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

type ReadinessLevel = "High" | "Medium" | "Low";

function computeReadiness(snapshot: DailySnapshotDTO | null): ReadinessLevel {
  if (!snapshot) return "Low";
  const steps = snapshot.steps ?? 0;
  const sleepMinutes = snapshot.sleep?.totalMinutes ?? 0;
  const metGoal = snapshot.sleep?.metGoal ?? false;

  if (metGoal && steps >= 8000) return "High";
  if (sleepMinutes >= 360 && steps >= 4000) return "Medium";
  return "Low";
}

export const Dashboard: React.FC = () => {
  const [snapshots, setSnapshots] = useState<DailySnapshotDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const userId = getQueryParam("userId");

  useEffect(() => {
    const controller = new AbortController();

    async function fetchSnapshots() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (userId) params.set("userId", userId);
        params.set("limit", "7");

        const url = `${API_BASE}/daily-snapshots?${params.toString()}`;
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const json = (await res.json()) as DailySnapshotsResponse;
        if (!json.ok) {
          throw new Error("Backend returned ok=false");
        }

        const sorted = [...json.snapshots].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );

        setSnapshots(sorted);
      } catch (err: any) {
        if (err.name === "AbortError") return;
        console.error(err);
        setError("Unable to load snapshots.");
      } finally {
        setLoading(false);
      }
    }

    fetchSnapshots();
    return () => controller.abort();
  }, [userId]);

  const today = snapshots[0] ?? null;

  const sleepChartData = useMemo(
    () =>
      [...snapshots]
        .slice(0, 7)
        .reverse()
        .map((s) => ({
          dateLabel: formatDateLabel(s.date),
          totalMinutes: s.sleep?.totalMinutes ?? 0,
          goalMinutes: s.sleep?.goalMinutes ?? 0
        })),
    [snapshots]
  );

  const averageSleep = useMemo(() => {
    const vals = snapshots
      .slice(0, 7)
      .map((s) => s.sleep?.totalMinutes)
      .filter((v): v is number => typeof v === "number");
    if (!vals.length) return null;
    const sum = vals.reduce((a, b) => a + b, 0);
    return Math.round(sum / vals.length);
  }, [snapshots]);

  const nightsMeetingGoal = useMemo(
    () => snapshots.slice(0, 7).filter((s) => s.sleep?.metGoal).length,
    [snapshots]
  );

  const readiness = computeReadiness(today);

  return (
    <div
      style={{
        fontFamily: "-apple-system, system-ui, BlinkMacSystemFont, sans-serif",
        padding: "16px",
        maxWidth: 480,
        margin: "0 auto",
        backgroundColor: "#f5f5f7",
        minHeight: "100vh"
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Vitaliage Snapshot</h1>
        <p style={{ margin: "4px 0 0", fontSize: 14, color: "#555" }}>
          Synced from your health data
        </p>
      </header>

      {loading && <p>Loading…</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {!loading && !error && today && (
        <>
          {/* Today Card */}
          <section
            style={{
              backgroundColor: "#ffffff",
              borderRadius: 16,
              padding: 16,
              boxShadow: "0 4px 10px rgba(0,0,0,0.06)",
              marginBottom: 16
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 8
              }}
            >
              <h2 style={{ fontSize: 18, margin: 0 }}>Today</h2>
              <span style={{ fontSize: 12, color: "#777" }}>
                {formatFullDate(today.date)}
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginBottom: 12
              }}
            >
              <Metric label="Steps" value={today.steps ?? undefined} />
              <Metric
                label="Resting HR"
                value={today.restingHR ?? undefined}
                suffix=" bpm"
              />
              <Metric
                label="VO₂ Max"
                value={
                  today.vo2Max !== null && today.vo2Max !== undefined
                    ? today.vo2Max.toFixed(1)
                    : undefined
                }
                suffix=" mL/kg/min"
              />
              <Metric
                label="Sleep last night"
                value={formatMinutesToHhMm(today.sleep?.totalMinutes ?? null)}
              />
            </div>

            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "4px 10px",
                borderRadius: 999,
                backgroundColor:
                  readiness === "High"
                    ? "rgba(46, 204, 113, 0.12)"
                    : readiness === "Medium"
                    ? "rgba(241, 196, 15, 0.12)"
                    : "rgba(231, 76, 60, 0.12)",
                fontSize: 12,
                color:
                  readiness === "High"
                    ? "#27ae60"
                    : readiness === "Medium"
                    ? "#f39c12"
                    : "#c0392b"
              }}
            >
              Readiness: {readiness}
            </div>
          </section>

          {/* Sleep Chart Card */}
          <section
            style={{
              backgroundColor: "#ffffff",
              borderRadius: 16,
              padding: 16,
              boxShadow: "0 4px 10px rgba(0,0,0,0.06)"
            }}
          >
            <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>
              Sleep · Last 7 nights
            </h2>
            <p style={{ fontSize: 12, color: "#777", margin: "0 0 12px" }}>
              Minutes slept vs goal
            </p>

            <div style={{ width: "100%", height: 200 }}>
              <ResponsiveContainer>
                <BarChart data={sleepChartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="dateLabel" />
                  <YAxis />
                  <Tooltip />
                  {sleepChartData[0]?.goalMinutes ? (
                    <ReferenceLine
                      y={sleepChartData[0].goalMinutes}
                      stroke="#888"
                      strokeDasharray="4 4"
                    />
                  ) : null}
                  <Bar dataKey="totalMinutes" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 12,
                fontSize: 12,
                color: "#555"
              }}
            >
              <span>
                Avg sleep:{" "}
                {averageSleep !== null
                  ? formatMinutesToHhMm(averageSleep)
                  : "—"}
              </span>
              <span>Met goal: {nightsMeetingGoal} / 7 nights</span>
            </div>
          </section>
        </>
      )}

      {!loading && !error && !today && (
        <p>No snapshots available yet. Open the Vitaliage iOS app to sync data.</p>
      )}
    </div>
  );
};

interface MetricProps {
  label: string;
  value?: number | string;
  suffix?: string;
}

const Metric: React.FC<MetricProps> = ({ label, value, suffix }) => {
  const display = value === undefined ? "—" : value;
  return (
    <div>
      <div style={{ fontSize: 12, color: "#777", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>
        {display}
        {suffix && display !== "—" ? suffix : ""}
      </div>
    </div>
  );
};

export default Dashboard;
