# The token flow
However the agent is installed, the owner needs a token to authenticate with your backend. The flow:

- Owner signs up on your platform and goes to the dashboard
- They click "Add machine" — backend generates a one-time agent_token tied to their account
- They copy the token and paste it into the install command
- On first run the agent calls POST /machines/register with the token, backend associates the machine with their account, returns a machine_id
- Agent saves machine_id + agent_token to ~/.computeshare/config.json and never needs the token again


---

# Install + Register in one step
`pip install -r requirements.txt`
`python agent.py start --token <your-token-from-dashboard> --backend https://your-platform.com`

# Subsequent runs (config already saved)
`python agent.py start`


---

Make it executable before pushing to git:
`bashchmod +x install.sh`
Your friend runs:
`curl -sSL https://raw.githubusercontent.com/yourname/computeshare-agent/main/install.sh`