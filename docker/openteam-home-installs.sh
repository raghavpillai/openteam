# Login shells reset PATH in /etc/profile; put the home volume's tool folders back in front.
for dir in /home/box/go/bin /home/box/.cargo/bin /home/box/.bun/bin /home/box/.local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
done
export PATH
