# Pitfalls — read before generating anything

<!-- One bullet per trap: what went wrong, the rule that avoids it, verified or guessed. -->

- Read a part's URDF visual `<origin>` before building against its raw mesh; the mesh's own frame
  is often not where the part sits in the robot.
