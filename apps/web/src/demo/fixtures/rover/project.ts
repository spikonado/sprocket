import { demoProject } from '../demo-project';
import { prompt, recordRun, say, think, tool, work } from '../rows';
import type { DemoThread } from '../types';

const drift: DemoThread = {
	id: 'rover-drift',
	title: 'Why does the rover drift left?',
	model: 'gpt-6-luna',
	effort: 'high',
	minutesAgo: 9,
	runs: [
		recordRun('run-rover-drift-1', [
			prompt(
				"The rover drifts left when I send it straight down the hallway. I recorded bags/hallway_run. It's on the network as rover.local if you need it."
			),
			work(
				tool('exec_cmd', 'ros2 bag info bags/hallway_run'),
				tool(
					'exec_cmd',
					'python3 scratch/wheel_tracking.py bags/hallway_run --topics /wheel/left /wheel/right /cmd_vel'
				),
				think(
					'Reading the wheel speeds',
					'Both wheels get the same 0.30 m/s setpoint. The right wheel averages 0.299 m/s and the left 0.288 m/s, 3.8% slow the whole run. A steady error like that is what a P-only loop leaves behind.'
				),
				tool('exec_cmd', 'cat config/wheels.yaml rover_control/rover_control/wheel_pid.py'),
				think(
					'Checking the gains',
					'`ki` is 0.0, so nothing removes the steady error. The left gearmotor has more friction: in the bag it needs 14% PWM to start turning, against 9% for the right. Add integral gain, and stop integrating while the output is saturated so it does not wind up against the limit.'
				),
				tool('apply_patch', 'config/wheels.yaml\nrover_control/rover_control/wheel_pid.py'),
				tool(
					'exec_cmd',
					'colcon build --packages-select rover_control && colcon test --packages-select rover_control'
				),
				tool(
					'exec_cmd',
					'rsync -a --exclude build --exclude install ./ rover.local:~/rover_ws/src/rover/'
				),
				tool(
					'exec_cmd',
					'ssh rover.local "cd rover_ws && colcon build --packages-select rover_control && ros2 launch rover_control straight_line.launch.py distance:=5.0"'
				),
				tool(
					'exec_cmd',
					'scp -r rover.local:~/rover_ws/bags/straight_5m bags/ && python3 scratch/wheel_tracking.py bags/straight_5m'
				)
			),
			say(`The left wheel ran 3.8% slow because the wheel PID had no integral term. The left gearmotor has more friction, and a P-only loop leaves a steady error.

I set \`ki\` to 2.0 and stopped the integral from winding up while the output is saturated. Then I drove 5 m straight on the rover:

| | Left wheel error | Right wheel error | Drift over 5 m |
| --- | --- | --- | --- |
| Before | −3.8% | −0.3% | 31 cm left |
| After | −0.2% | −0.1% | 3 cm left |

Both wheels settle within 0.4 s of a speed change, and neither overshoots by more than 4%. The 3 cm that's left is in the range of the floor and tire differences, and \`robot_localization\` corrects it with the IMU.`)
		])
	]
};

export const rover = demoProject({
	name: 'rover',
	files: {
		'README.md': `# rover

A two-wheel ROS 2 Jazzy rover on a Raspberry Pi 5, with 1920-count encoders and an IMU.

\`\`\`sh
colcon build
ros2 launch rover_control bringup.launch.py
\`\`\`
`,
		'config/wheels.yaml': `wheel_pid:
  ros__parameters:
    rate_hz: 50.0
    kp: 0.9
    ki: 2.0
    kd: 0.01
    output_limit: 1.0
    wheel_radius_m: 0.0425
    track_width_m: 0.21
    counts_per_rev: 1920
`,
		'rover_control/rover_control/wheel_pid.py': `class WheelPid:
    def __init__(self, kp: float, ki: float, kd: float, limit: float):
        self.kp, self.ki, self.kd, self.limit = kp, ki, kd, limit
        self.integral = 0.0
        self.last_error = 0.0

    def update(self, setpoint: float, measured: float, dt: float) -> float:
        error = setpoint - measured
        derivative = (error - self.last_error) / dt
        self.last_error = error
        output = self.kp * error + self.ki * self.integral + self.kd * derivative

        # Stop integrating while saturated, so the integral can't wind up.
        if abs(output) < self.limit:
            self.integral += error * dt

        return max(-self.limit, min(self.limit, output))
`
	},
	gitStatus: [
		{ path: 'config/wheels.yaml', status: 'modified' },
		{ path: 'rover_control/rover_control/wheel_pid.py', status: 'modified' }
	],
	threads: [drift]
});
