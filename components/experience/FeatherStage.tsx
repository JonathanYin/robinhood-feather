"use client";

import dynamic from "next/dynamic";

const FeatherExperience = dynamic(() => import("./FeatherExperience"), {
  ssr: false,
  loading: () => <div aria-hidden="true" className="feather-stage" />,
});

export default function FeatherStage() {
  return <FeatherExperience />;
}
