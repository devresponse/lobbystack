import type { Metadata } from "next";

import { profileRouteMetadata, renderProfileRoute } from "@/components/public-profile/profile-route";

// A business's public page, answered by its default receptionist.

type ProfileRouteProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: ProfileRouteProps): Promise<Metadata> {
  const { slug } = await params;
  return profileRouteMetadata(slug, null);
}

export default async function PublicProfileRoute({ params }: ProfileRouteProps) {
  const { slug } = await params;
  return renderProfileRoute(slug, null);
}
