import { redirect } from "next/navigation";

// Root URL → start screen (Free Nesting / Open project / New project). Logged-out visitors are sent to /login by src/proxy.ts.
export default function Home() {
  redirect("/start");
}
