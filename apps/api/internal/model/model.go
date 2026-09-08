package model

import "time"

type Channel struct {
	ID, Name, Slug, Description string
	Priority                    int
	IsActive                    bool
	CreatedAt                   time.Time
}
type Device struct {
	ID, Name, DeviceKey, Type, Location, Status string
	Volume                                      int
	LastSeenAt                                  *time.Time
	CreatedAt                                   time.Time
}
type Session struct {
	ID, ChannelID       string
	BroadcasterDeviceID *string
	StartedAt           time.Time
	EndedAt             *time.Time
	PeakListeners       int
	Status              string
}
