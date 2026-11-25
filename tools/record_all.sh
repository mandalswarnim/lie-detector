#!/usr/bin/env zsh
# Guided recording of tuning sessions. Run from anywhere:
#   ./tools/record_all.sh            round 1 (first set)
#   ./tools/record_all.sh round2     round 2: 800 Hz, wrists on/off test, still, fidget
# Asks for your password once (the sensor needs sudo).
cd "${0:A:h}/.."
PY=.venv/bin/python
SET="${1:-round1}"

# No sound while recording: the speakers shake the chassis and pollute the IMU.
chime() { afplay /System/Library/Sounds/Glass.aiff 2>/dev/null & }

# name | seconds | labelled? | instruction | cues "sec:TEXT;sec:TEXT"
case $SET in
  round1) sessions=(
    "off_1|30|no|Take your hands OFF the laptop (rest them in your lap). Don't touch the table.|"
    "still_1|60|yes|Rest both wrists on the palm rest, normal pressure. Stay completely still and quiet.|"
    "breath_1|60|yes|Wrists on the palm rest. Hold your breath for the first 20 s, then breathe gently. Stay still.|"
    "still_2|60|yes|Wrists on the palm rest with LIGHT pressure. Stay still.|"
    "still_3|60|yes|Wrists on the palm rest with HEAVIER pressure (let your arms' weight sink in). Stay still.|"
    "fidget_1|60|yes|Wrists on. Still for 20 s, then FIDGET for 10 s (on-screen cue), then still for 30 s.|20:FIDGET NOW (10 s);30:STOP. Stay still."
  ) ;;
  round2) sessions=(
    "onoff_1|70|no|Start with hands OFF (in your lap, body still). Follow the on-screen cues: wrists ON / OFF every 10 s. Sit still between moves.|10:WRISTS ON (normal);20:HANDS OFF;30:WRISTS ON (LIGHT touch);40:HANDS OFF;50:WRISTS ON (HEAVY);60:HANDS OFF"
    "still800_1|60|yes|Wrists on the palm rest, normal pressure. Completely still and quiet.|"
    "still800_2|60|yes|Wrists on, heavier pressure. Completely still and quiet.|"
    "fidget800_1|60|yes|Wrists on. Follow the cues: small fidget, then a BIG squirm.|15:SMALL fidget (shift your hands a little);22:STOP. Still.;35:BIG squirm (shift around, like you're nervous);42:STOP. Still."
    "lean800_1|40|no|Hands OFF the laptop. Follow the cues: lean on / tap the TABLE (not the laptop).|10:LEAN your forearms on the TABLE (not the laptop);20:SIT BACK;30:TAP the table lightly a few times"
  ) ;;
  *) echo "usage: $0 [round1|round2]"; exit 1 ;;
esac

echo "\n=== MacBook Lie Detector: guided recording ($SET) ===\n"
echo "Hard table, charger unplugged, nothing else touching the table."
echo "Close other apps that make noise. Keep your Apple Watch on to read your heart rate.\n"
sudo -v || exit 1

read "bpm?What does your watch say your heart rate is right now? (e.g. 80): "
[[ -z $bpm ]] && bpm=80

i=0
for s in $sessions; do
  i=$((i+1))
  IFS='|' read name secs labelled what cues <<< "$s"
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
  if [[ -n $cues ]]; then
    ( last=0
      for c in ${(s:;:)cues}; do
        at=${c%%:*}; text=${c#*:}
        sleep $(( at - last )); last=$at
        print "\n\n>>> $text <<<\n"
      done ) &
  fi
  sudo $PY -m sensor "${args[@]}"
  wait 2>/dev/null
  chime
  if [[ $labelled == yes ]]; then
    read "nb?  Watch heart rate now? (Enter to keep $bpm): "
    if [[ -n $nb && $nb != $bpm ]]; then
      echo "  Using average $(( (bpm + nb) / 2.0 )) for this recording's label."
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
echo "\nNow tell Claude \"recorded\"."
