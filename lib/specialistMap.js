// lib/specialistMap.js
export const SPECIALIST_MAP = {
  "aakash.revankar@loopwork.co": { fathomName: "Aakash Revankar", displayName: "Aakash" },
  "aditi.goel@loopwork.co":      { fathomName: "Aditi Goel",      displayName: "Aditi"  },
  "aditya.gupta@loopwork.co":    { fathomName: "Aditya Gupta",    displayName: "Aditya" },
  "devak.grover@loopwork.co":    { fathomName: "Devak Grover",    displayName: "Devak"  },
  "jagrit.popli@loopwork.co":    { fathomName: "Jagrit Popli",    displayName: "Jagrit" },
  "ritima.singh@loopwork.co":    { fathomName: "Ritima Singh",    displayName: "Ritima" },
  "shivam.kumar@loopwork.co":    { fathomName: "Shivam Kumar",    displayName: "Shivam" },
  "tarun.rana@loopwork.co":      { fathomName: "Tarun Rana",      displayName: "Tarun"  },
};

// Set of Fathom display names for fast lookup — used to filter calls
export const POC_FATHOM_NAMES = new Set(
  Object.values(SPECIALIST_MAP).map(s => s.fathomName.trim().toLowerCase())
);
