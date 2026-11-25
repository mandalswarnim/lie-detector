#!/usr/bin/env zsh
# Guided recording of the tuning sessions. Run from anywhere:  ./tools/record_all.sh
# Asks for your password once (the sensor needs sudo).
cd "${0:A:h}/.."
PY=.venv/bin/python

# No sound while recording: the speakers shake the chassis and pollute the IMU.
chime() { afplay /System/Library/Sounds/Glass.aiff 2>/dev/null & }

echo "\n=== MacBook Lie Detector: guided recording ===\n"
echo "Hard table, charger unplugged, nothing else touching the table."
echo "Close other apps that make noise. Keep your Apple Watch on to read your heart rate.\n"
sudo -v || exit 1

read "bpm?What does your watch say your heart rate is right now? (e.g. 80): "
[[ -z $bpm ]] && bpm=80

# name | seconds | true-bpm? | instruction
sessions=(
  "off_1|30|no|Take your hands OFF the laptop (rest them in your lap). Don't touch the table."
  "still_1|60|yes|Rest both wrists on the palm rest, normal pressure. Stay completely still and quiet."
  "breath_1|60|yes|Wrists on the palm rest. Hold your breath for the first 20 s, then breathe gently. Stay still."
  "still_2|60|yes|Wrists on the palm rest with LIGHT pressure. Stay still."
  "still_3|60|yes|Wrists on the palm rest with HEAVIER pressure (let your arms' weight sink in). Stay still."
  "fidget_1|60|yes|Wrists on. Still for 20 s, then FIDGET for 10 s (on-screen cue), then still for 30 s."
)

i=0
for s in $sessions; do
  i=$((i+1))
  IFS='|' read name secs labelled what <<< "$s"
  echo "\n--------------------------------------------------------------"
  echo "Session $i of ${#sessions}:  $name  ($secs s)"
  echo "  $what"
  if [[ -f recordings/$name.npz ]]; then
    read "ans?  recordings/$name.npz already exists. Overwrite? [y/N/s=skip all remaining]: "
    [[ $ans == s ]] && break
    [[ $ans != y ]] && continue
  fi
  read "?  Get into position, then press Enter. Recording starts after 3 s..."
  sudo -v
  sleep 3
  args=(--record $name --seconds $secs --notes "$what")
  [[ $labelled == yes ]] && args+=(--true-bpm $bpm)
  if [[ $name == fidget_* ]]; then
    ( sleep 20; print "\n\n>>> FIDGET NOW (10 s) <<<\n"; sleep 10; print "\n\n>>> STOP. Stay still. <<<\n" ) &
  fi
  sudo $PY -m sensor "${args[@]}"
  wait 2>/dev/null
  chime
  if [[ $labelled == yes ]]; then
    read "nb?  Watch heart rate now? (Enter to keep $bpm): "
    if [[ -n $nb && $nb != $bpm ]]; then
      echo "  Using average $(( (bpm + nb) / 2 )) for this recording's label."
      $PY - "$name" "$(( (bpm + nb) / 2.0 ))" <<'EOF'
import json, sys, numpy as np
p = f"recordings/{sys.argv[1]}.npz"; d = dict(np.load(p))
m = json.loads(str(d["meta"])); m["true_bpm"] = float(sys.argv[2])
d["meta"] = np.array(json.dumps(m)); np.savez_compressed(p, **d)
EOF
      bpm=$nb
    fi
  fi
done

echo "\nAll done. Recordings:"
ls -1 recordings/*.npz
echo "\nNow tell Claude \"recorded\" (or run: $PY tools/tune.py recordings/*.npz --spectrum --levels --sweep)"
