import { redirect } from "next/navigation";

// Old URL of the page that was rebuilt as Scrap Management.
export default function ScrapMaterialRedirect() {
  redirect("/takeoff/scrap-management");
}
