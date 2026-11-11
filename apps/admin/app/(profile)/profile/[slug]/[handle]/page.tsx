import type { Metadata } from "next";

import { profileRouteMetadata, renderProfileRoute } from "@/components/public-profile/profile-route";

// A receptionist's own page under the business page, answered by that
// receptionist. A paused or archived receptionist's page, or the default
// one's, sends visitors to the business page.

type ReceptionistRouteProps = { params: Promise<{ slug: string; handle: string }> };

export async function generateMetadata({ params }: ReceptionistRouteProps): Promise<Metadata> {
  const { slug, handle } = await params;
  return profileRouteMetadata(slug, handle);
}

export default async function ReceptionistProfileRoute({ params }: ReceptionistRouteProps) {
  const { slug, handle } = await params;
  return renderProfileRoute(slug, handle);
}
